export {
  defineMap,
  defineMappingPolicy,
  findRuntimePolicyViolations,
  handleRuntimePolicyViolations,
  makeMapper,
  mapperHelpers,
  source,
  transform,
  type DefinedMap,
  type Mapper,
  type MapperMetadata,
  type MapperOptions,
  type MappingPolicy,
  type MappingPolicyMode,
  type MapRule,
  type MapSpec,
  type PathOf,
} from "./mapper.js";

export {
  emitMapperFromSpec,
  findMapPolicyViolations,
  handleMapPolicyViolations,
  readMapRules,
  resolveMapSpecObject,
  skipExpression,
  type MapperEmitOptions,
  type MapPolicyViolation,
  type MapRuleInfo,
} from "./emit-mapper.js";

export {
  emitPathAccess,
  emitPropertyAccess,
  emitSafePathAccess,
  getByPath,
  parsePath,
  type PathSegment,
} from "./path.js";

export { generateJSDocFromSpec, type GenerateJSDocOptions } from "./generate-jsdoc.js";

export {
  generateDocsFromProgram,
  isMapperDocsSourceFile,
  type GeneratedDocsFile,
  type GeneratedDocsFileName,
  type GeneratedDocsFileNameContext,
  type MapperDocsOptions,
} from "./generate-docs.js";

export { default as tsTransformer, type MapperTransformerOptions } from "./ts-transformer.js";
export {
  default as vitePlugin,
  type SmartSchemaConverterVitePluginOptions,
} from "./vite-plugin.js";
