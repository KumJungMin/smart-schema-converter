import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  generateDocsFromProgram,
  isMapperDocsSourceFile,
  type GeneratedDocsFile,
  type MapperDocsOptions,
} from "./generate-docs.js";
import tsTransformer from "./ts-transformer.js";

type ViteTransformResult = string | { code: string; map: null } | null | undefined;
type ViteHotUpdateContext = {
  file: string;
};

type VitePluginLike = {
  name: string;
  enforce?: "pre";
  configResolved?: (config: { root: string }) => void;
  buildStart?: () => void;
  handleHotUpdate?: (context: ViteHotUpdateContext) => void;
  transform?: (code: string, id: string) => ViteTransformResult;
};

export type SmartSchemaConverterVitePluginOptions = {
  docs?: MapperDocsOptions;
  mapper?: boolean;
};

export default function vitePlugin(options?: SmartSchemaConverterVitePluginOptions): VitePluginLike {
  let root = process.cwd();
  let generatedDocFiles = new Set<string>();
  const shouldTransformMapper = options?.mapper !== false;

  return {
    name: "vite-plugin-smart-schema-converter",
    enforce: "pre",

    configResolved(config: { root: string }) {
      root = config.root;
    },

    buildStart() {
      if (!options?.docs) return;
      generatedDocFiles = generatedFileSet(writeGeneratedDocs(root, options.docs));
    },

    handleHotUpdate(context: ViteHotUpdateContext) {
      if (!options?.docs) return;
      if (generatedDocFiles.has(normalizeFileName(context.file))) return;
      if (!isMapperDocsSourceFile({ fileName: context.file, rootDir: root, docs: options.docs })) return;
      generatedDocFiles = generatedFileSet(writeGeneratedDocs(root, options.docs));
    },

    transform(code: string, id: string) {
      if (!shouldTransformMapper) return undefined;
      const isTypeScript = id.endsWith(".ts") || id.endsWith(".tsx");
      if (!isTypeScript || !/makeMapper\s*</.test(code)) return undefined;

      const { program } = createProgramFor(id);
      const sourceFile = program.getSourceFile(id);
      if (!sourceFile) return undefined;

      const result = ts.transform(sourceFile, [tsTransformer({ program })]);
      const transformed = ts.createPrinter().printFile(result.transformed[0] as ts.SourceFile);
      result.dispose();

      return transformed === code ? null : { code: transformed, map: null };
    },
  };
}

function generatedFileSet(files: GeneratedDocsFile[]): Set<string> {
  return new Set(files.map((file) => normalizeFileName(file.fileName)));
}

function normalizeFileName(fileName: string): string {
  return path.resolve(fileName);
}

function writeGeneratedDocs(root: string, docs: MapperDocsOptions): GeneratedDocsFile[] {
  const { program } = createProgramForRoot(root);
  const files = generateDocsFromProgram({ program, rootDir: root, docs });

  for (const file of files) {
    fs.mkdirSync(path.dirname(file.fileName), { recursive: true });
    if (ts.sys.fileExists(file.fileName) && ts.sys.readFile(file.fileName) === file.content) continue;
    fs.writeFileSync(file.fileName, file.content);
  }

  return files;
}

function createProgramFor(file: string): { program: ts.Program } {
  return createProgramForRoot(path.dirname(file));
}

function createProgramForRoot(root: string): { program: ts.Program } {
  const tsconfig = findNearestTsconfig(root);
  const config = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsconfig));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  return { program };
}

function findNearestTsconfig(start: string): string {
  let dir = start;

  while (true) {
    const candidate = path.join(dir, "tsconfig.json");
    if (ts.sys.fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const fallback = path.join(process.cwd(), "tsconfig.json");
  if (ts.sys.fileExists(fallback)) return fallback;
  throw new Error("tsconfig.json not found");
}
