import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import {
  generateDocsFromProgram,
  tsTransformer,
  vitePlugin,
} from "../dist/index.js";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smart-schema-converter-"));
  const fileName = path.join(root, "user.mapper.ts");

  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["*.ts"],
    })
  );

  fs.writeFileSync(
    fileName,
    `
declare function defineMap<TDto, TDomain>(): (spec: any) => any;
declare function source(from: string, metadata?: any): any;
declare function transform(from: string, fn: any, metadata?: any): any;
declare function makeMapper<TDto, TDomain>(spec: any): (dto: TDto) => TDomain;

interface UserDto {
  user_id: string;
  profile?: { name: string | null };
  age: number;
  status?: string;
}

interface UserSource {
  /** User id in the domain model */
  id: string;
  /** Display name */
  name: string;
  ageLabel: string;
  status: string;
}

const userMap = defineMap<UserDto, UserSource>()({
  id: source("user_id", { dtoDescription: "Identifier returned by the API.", dtoOrigin: "users.id" }),
  name: source("profile.name", { defaultValue: "Anonymous" }),
  ageLabel: transform("age", (value: unknown) => String(value)),
  status: source("status", { domainDescription: "Status shown in the domain.", defaultValue: "ACTIVE" }),
});

export const toUser = makeMapper<UserDto, UserSource>(userMap);
`
  );

  const program = createProgram(root);

  return { root, fileName, program };
}

function createProgram(root) {
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

test("generates JSDoc interfaces from defineMap declarations", () => {
  const { root, program } = createFixture();

  const files = generateDocsFromProgram({
    program,
    rootDir: root,
    docs: { include: "**/*.mapper.ts" },
  });

  assert.equal(files.length, 1);
  assert.equal(path.basename(files[0].fileName), "smart-schema.generated.ts");
  assert.match(files[0].content, /export interface User/);
  assert.doesNotMatch(files[0].content, /UserSource/);
  assert.match(files[0].content, /User id in the domain model/);
  assert.match(files[0].content, /- DTO: `UserDto.user_id`/);
  assert.match(files[0].content, /- DTO description: Identifier returned by the API\./);
  assert.match(files[0].content, /- DTO origin: `users.id`/);
  assert.match(files[0].content, /Status shown in the domain\./);
  assert.match(files[0].content, /ageLabel: string;/);
  assert.match(files[0].content, /status: string;/);
});

test("transforms makeMapper calls into inline mapper functions", () => {
  const { fileName, program } = createFixture();
  const sourceFile = program.getSourceFile(fileName);
  assert.ok(sourceFile);

  const result = ts.transform(sourceFile, [tsTransformer({ program })]);
  const output = ts.createPrinter().printFile(result.transformed[0]);
  result.dispose();

  assert.match(output, /const S=/);
  assert.match(output, /const S=\{"id":\{from:"user_id"/);
  assert.match(output, /input\?\.\["user_id"\]/);
  assert.match(output, /input\?\.\["profile"\]\?\.\["name"\]/);
  assert.match(output, /defaultValue: "ACTIVE"/);
  assert.match(output, /typeof rule.transform==="function"/);
  assert.doesNotMatch(output, /const S=.*source\(/s);
  assert.doesNotMatch(output, /makeMapper<UserDto, UserSource>/);
});

test("generated mapper matches runtime fallback for missing nested paths and defaultValue", () => {
  const { fileName, program } = createFixture();
  const sourceFile = program.getSourceFile(fileName);
  assert.ok(sourceFile);

  const result = ts.transform(sourceFile, [tsTransformer({ program })]);
  const output = ts.createPrinter().printFile(result.transformed[0]);
  result.dispose();

  const js = ts.transpileModule(output, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  const defineMap = () => (spec) => spec;
  const source = (from, metadata) => ({ from, ...metadata });
  const transform = (from, transform, metadata) => ({ from, transform, ...metadata });

  Function("exports", "defineMap", "source", "transform", js)(
    exports,
    defineMap,
    source,
    transform
  );

  assert.deepEqual(
    exports.toUser({ user_id: "u1", age: 7 }),
    {
      id: "u1",
      name: "Anonymous",
      ageLabel: "7",
      status: "ACTIVE",
    }
  );
  assert.deepEqual(
    exports.toUser({ user_id: "u2", profile: { name: null }, age: 8, status: null }),
    {
      id: "u2",
      name: null,
      ageLabel: "8",
      status: null,
    }
  );
});

test("does not transform local makeMapper implementations with the same name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smart-schema-converter-local-"));
  const fileName = path.join(root, "local.ts");

  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["*.ts"],
    })
  );
  fs.writeFileSync(
    fileName,
    `
function makeMapper<TDto, TDomain>(spec: unknown): (dto: TDto) => TDomain {
  return () => spec as TDomain;
}

interface UserDto {
  user_id: string;
}

interface User {
  id: string;
}

const spec = { id: { from: "user_id" } };
export const toUser = makeMapper<UserDto, User>(spec);
`
  );

  const program = createProgram(root);
  const sourceFile = program.getSourceFile(fileName);
  assert.ok(sourceFile);

  const result = ts.transform(sourceFile, [tsTransformer({ program })]);
  const output = ts.createPrinter().printFile(result.transformed[0]);
  result.dispose();

  assert.match(output, /function makeMapper/);
  assert.match(output, /makeMapper<UserDto, User>\(spec\)/);
  assert.doesNotMatch(output, /const S=/);
});

test("vite plugin regenerates JSDoc files when an included mapper file hot-updates", () => {
  const { root, fileName } = createFixture();
  const plugin = vitePlugin({ docs: { include: "**/*.mapper.ts" } });
  plugin.configResolved?.({ root });
  plugin.buildStart?.();

  const generatedFile = path.join(root, "smart-schema.generated.ts");
  const initial = fs.readFileSync(generatedFile, "utf8");
  assert.match(initial, /Identifier returned by the API\./);

  const nextSource = fs.readFileSync(fileName, "utf8").replace(
    "Identifier returned by the API.",
    "Identifier changed during dev."
  );
  fs.writeFileSync(fileName, nextSource);
  plugin.handleHotUpdate?.({ file: fileName });

  const updated = fs.readFileSync(generatedFile, "utf8");
  assert.match(updated, /Identifier changed during dev\./);
});
