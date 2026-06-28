import path from "node:path";
import ts from "typescript";
import { generateJSDocFromSpec } from "./generate-jsdoc.js";

export type GeneratedDocsFileNameContext = {
  sourceFileName: string;
  sourceFileBaseName: string;
  sourceFileDir: string;
  rootDir: string;
};

export type GeneratedDocsFileName =
  | string
  | ((context: GeneratedDocsFileNameContext) => string);

export type MapperDocsOptions =
  | boolean
  | {
      include?: string | string[];
      exclude?: string | string[];
      sourceSuffix?: string;
      generatedFileName?: GeneratedDocsFileName;
      outDir?: "near-source";
      policyMode?: "warn" | "error";
    };

export type GeneratedDocsFile = {
  fileName: string;
  content: string;
};

type NormalizedDocsOptions = {
  include: string[];
  exclude: string[];
  sourceSuffix: string;
  generatedFileName: GeneratedDocsFileName;
  policyMode: "warn" | "error";
};

type MapperDoc = {
  generatedName: string;
  dtoType: ts.Type;
  domainType: ts.Type;
  specNode: ts.Expression;
};

export function generateDocsFromProgram(params: {
  program: ts.Program;
  rootDir: string;
  docs: MapperDocsOptions;
}): GeneratedDocsFile[] {
  const options = normalizeDocsOptions(params.docs);
  if (!options) return [];

  const checker = params.program.getTypeChecker();
  const groups = new Map<string, MapperDoc[]>();

  const sourceFiles = params.program
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile && isIncluded(sourceFile.fileName, params.rootDir, options))
    .sort((a, b) => toPosix(a.fileName).localeCompare(toPosix(b.fileName)));

  for (const sourceFile of sourceFiles) {
    const mapperDocs = findMapperDocs(checker, sourceFile, options);
    if (!mapperDocs.length) continue;

    const generatedFileName = resolveGeneratedFileName(sourceFile, params.rootDir, options);
    const fileName = path.join(path.dirname(sourceFile.fileName), generatedFileName);

    for (const doc of mapperDocs) {
      const docs = groups.get(fileName) ?? [];
      docs.push(doc);
      groups.set(fileName, docs);
    }
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => toPosix(a).localeCompare(toPosix(b)))
    .map(([fileName, docs]) => ({
      fileName,
      content: generateFileContent(checker, fileName, docs, options),
    }));
}

export function isMapperDocsSourceFile(params: {
  fileName: string;
  rootDir: string;
  docs: MapperDocsOptions;
}): boolean {
  const options = normalizeDocsOptions(params.docs);
  return !!options && isIncluded(params.fileName, params.rootDir, options);
}

function normalizeDocsOptions(options: MapperDocsOptions): NormalizedDocsOptions | null {
  if (!options) return null;
  const object = typeof options === "object" ? options : {};
  if (object.outDir && object.outDir !== "near-source") {
    throw new Error('[smart-schema-converter/docs] docs.outDir currently supports only "near-source".');
  }

  const generatedFileName = object.generatedFileName ?? "smart-schema.generated.ts";
  const generatedFileExcludes =
    typeof generatedFileName === "string" ? [`**/${generatedFileName}`] : ["**/*.generated.ts"];

  return {
    include: array(object.include ?? ["**/*.mapper.ts", "**/*.mapper.tsx"]),
    exclude: [...array(object.exclude), ...generatedFileExcludes],
    sourceSuffix: object.sourceSuffix ?? "Source",
    generatedFileName,
    policyMode: object.policyMode ?? "warn",
  };
}

function resolveGeneratedFileName(
  sourceFile: ts.SourceFile,
  rootDir: string,
  options: NormalizedDocsOptions
): string {
  if (typeof options.generatedFileName === "function") {
    return options.generatedFileName({
      sourceFileName: sourceFile.fileName,
      sourceFileBaseName: path.basename(sourceFile.fileName),
      sourceFileDir: path.dirname(sourceFile.fileName),
      rootDir,
    });
  }

  return options.generatedFileName;
}

function isIncluded(fileName: string, rootDir: string, options: NormalizedDocsOptions): boolean {
  return matchesAny(fileName, rootDir, options.include) && !matchesAny(fileName, rootDir, options.exclude);
}

function findMapperDocs(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  options: NormalizedDocsOptions
): MapperDoc[] {
  const docs: MapperDoc[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const map = readDefineMapCall(node.initializer);
      if (map) {
        const domainType = checker.getTypeFromTypeNode(map.domainTypeNode);
        const domainName = typeName(checker, domainType, map.domainTypeNode, sourceFile);
        const generatedName = generatedNameFromDomain(domainName, options.sourceSuffix);

        if (generatedName) {
          docs.push({
            generatedName,
            dtoType: checker.getTypeFromTypeNode(map.dtoTypeNode),
            domainType,
            specNode: map.specNode,
          });
        } else {
          handleConventionIssue(
            `[smart-schema-converter/docs] Skipping ${node.name.text}: ${generatedNameIssue(
              domainName,
              options.sourceSuffix
            )}.`,
            options.policyMode
          );
        }
      }
    }

    node.forEachChild(visit);
  };

  visit(sourceFile);
  return docs;
}

function readDefineMapCall(node: ts.Expression): {
  dtoTypeNode: ts.TypeNode;
  domainTypeNode: ts.TypeNode;
  specNode: ts.Expression;
} | null {
  const specCall = skipExpression(node);
  if (!ts.isCallExpression(specCall) || !specCall.arguments[0]) return null;

  const factoryCall = skipExpression(specCall.expression);
  if (!ts.isCallExpression(factoryCall) || factoryCall.typeArguments?.length !== 2) return null;
  if (!isDefineMapExpression(skipExpression(factoryCall.expression))) return null;

  return {
    dtoTypeNode: factoryCall.typeArguments[0],
    domainTypeNode: factoryCall.typeArguments[1],
    specNode: specCall,
  };
}

function isDefineMapExpression(node: ts.Expression): boolean {
  return (
    (ts.isIdentifier(node) && node.text === "defineMap") ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "defineMap")
  );
}

function generateFileContent(
  checker: ts.TypeChecker,
  fileName: string,
  docs: MapperDoc[],
  options: NormalizedDocsOptions
): string {
  const names = new Set<string>();
  const interfaces: string[] = [];

  for (const doc of docs) {
    if (names.has(doc.generatedName)) {
      throw new Error(
        `[smart-schema-converter/docs] Generated interface "${doc.generatedName}" conflicts in ${fileName}.`
      );
    }

    names.add(doc.generatedName);
    interfaces.push(
      generateJSDocFromSpec({
        checker,
        dtoType: doc.dtoType,
        domainType: doc.domainType,
        specNode: doc.specNode,
        options: { name: doc.generatedName, policyMode: options.policyMode },
      })
    );
  }

  return `${interfaces.join("\n\n")}\n`;
}

function generatedNameFromDomain(domainName: string, sourceSuffix: string): string | null {
  if (!sourceSuffix) return domainName;
  if (!domainName.endsWith(sourceSuffix)) return null;

  const generatedName = domainName.slice(0, -sourceSuffix.length);
  return generatedName || null;
}

function generatedNameIssue(domainName: string, sourceSuffix: string): string {
  if (!sourceSuffix) return `domain type "${domainName}" does not produce a generated interface name`;
  if (!domainName.endsWith(sourceSuffix)) {
    return `domain type "${domainName}" does not end with "${sourceSuffix}"`;
  }
  return `domain type "${domainName}" would produce an empty generated interface name`;
}

function typeName(
  checker: ts.TypeChecker,
  type: ts.Type,
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile
): string {
  return (
    type.aliasSymbol?.name ??
    type.symbol?.name ??
    checker.typeToString(type, typeNode) ??
    typeNode.getText(sourceFile)
  );
}

function handleConventionIssue(message: string, mode: "warn" | "error"): void {
  if (mode === "error") throw new Error(message);
  console.warn(message);
}

function matchesAny(fileName: string, rootDir: string, patterns: string[]): boolean {
  const absolute = toPosix(path.resolve(fileName));
  const relative = toPosix(path.relative(rootDir, fileName));

  return patterns.some((pattern) => {
    const normalized = toPosix(pattern);
    const target = path.isAbsolute(pattern) ? absolute : relative;
    return globToRegExp(normalized).test(target);
  });
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === "*") {
      if (next === "*") {
        const after = pattern[i + 2];
        if (after === "/") {
          regex += "(?:.*/)?";
          i += 2;
        } else {
          regex += ".*";
          i += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    regex += escapeRegex(char);
  }

  return new RegExp(`${regex}$`);
}

function escapeRegex(value: string): string {
  return /[\\^$+?.()|[\]{}]/.test(value) ? `\\${value}` : value;
}

function skipExpression(node: ts.Expression): ts.Expression {
  let expr = node;
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}

function array<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}
