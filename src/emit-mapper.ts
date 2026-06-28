import ts from "typescript";
import { emitSafePathAccess } from "./path.js";

export type MapperEmitOptions = {
  mappingPolicy?: ts.Expression;
  policyMode?: "warn" | "error";
};

export type MapRuleInfo = {
  key: string;
  from: string;
  dtoOrigin?: string;
  domainDescription?: string;
  dtoDescription?: string;
};

export type MapPolicyViolation = {
  from: string;
  expectedKey: string;
  actualKey: string;
};

export function emitMapperFromSpec(params: {
  checker: ts.TypeChecker;
  domainType: ts.Type;
  specNode: ts.Expression;
  sourceFile: ts.SourceFile;
  options?: MapperEmitOptions;
}): string | null {
  const specObject = resolveMapSpecObject(params.checker, params.specNode);
  if (!specObject) return null;

  handleMapPolicyViolations(
    findMapPolicyViolations(params.checker, specObject, params.options?.mappingPolicy),
    params.options?.policyMode ?? "warn"
  );

  const rules = readMapRules(params.checker, specObject);
  const fields: string[] = [];

  for (const prop of params.checker.getPropertiesOfType(params.domainType)) {
    const rule = rules.get(prop.name);
    if (!rule) return null;
    fields.push(`${JSON.stringify(prop.name)}:R(${JSON.stringify(prop.name)},${emitSafePathAccess("input", rule.from)})`);
  }

  const specText = emitRuntimeSpecText(specObject, params.sourceFile);

  return [
    `(function(){const S=${specText};`,
    `return(input)=>{`,
    `const R=(key,raw)=>{const rule=S[key];const value=raw===undefined&&Object.prototype.hasOwnProperty.call(rule,"defaultValue")?rule.defaultValue:raw;return typeof rule.transform==="function"?rule.transform(value,input):value;};`,
    `return {${fields.join(",")}};`,
    `};})()`,
  ].join("");
}

export function readMapRules(checker: ts.TypeChecker, specNode: ts.Expression): Map<string, MapRuleInfo> {
  const object = resolveMapSpecObject(checker, specNode);
  const rules = new Map<string, MapRuleInfo>();
  if (!object) return rules;

  for (const prop of object.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;

    const key = propertyName(prop.name);
    const rule = readRule(prop.initializer);
    if (key && rule) rules.set(key, { key, ...rule });
  }

  return rules;
}

export function findMapPolicyViolations(
  checker: ts.TypeChecker,
  specNode: ts.Expression,
  policyNode: ts.Expression | undefined
): MapPolicyViolation[] {
  if (!policyNode) return [];

  const rules = readMapRules(checker, specNode);
  const policyRules = readMapRules(checker, policyNode);
  const canonicalByPath = new Map<string, string>();
  const violations: MapPolicyViolation[] = [];

  for (const rule of policyRules.values()) {
    const existing = canonicalByPath.get(rule.from);
    if (existing && existing !== rule.key) {
      violations.push({ from: rule.from, expectedKey: existing, actualKey: rule.key });
      continue;
    }
    canonicalByPath.set(rule.from, rule.key);
  }

  for (const rule of rules.values()) {
    const expected = canonicalByPath.get(rule.from);
    if (expected && expected !== rule.key) {
      violations.push({ from: rule.from, expectedKey: expected, actualKey: rule.key });
    }
  }

  return violations;
}

export function handleMapPolicyViolations(
  violations: MapPolicyViolation[],
  mode: "warn" | "error"
): void {
  if (!violations.length) return;

  const details = violations
    .map((item) =>
      `DTO path "${item.from}" is canonically mapped as "${item.expectedKey}", but this map uses "${item.actualKey}".`
    )
    .join("\n");
  const message = `[smart-schema-converter/mapper] Mapping policy violation:\n${details}`;

  if (mode === "error") throw new Error(message);
  console.warn(message);
}

export function resolveMapSpecObject(
  checker: ts.TypeChecker,
  node: ts.Expression
): ts.ObjectLiteralExpression | null {
  const expr = skipExpression(node);
  if (ts.isObjectLiteralExpression(expr)) return expr;

  if (ts.isCallExpression(expr) && expr.arguments[0]) {
    const arg = skipExpression(expr.arguments[0]);
    if (ts.isObjectLiteralExpression(arg)) return arg;
  }

  if (ts.isCallExpression(expr) && ts.isCallExpression(expr.expression)) {
    return resolveMapSpecObject(checker, expr.expression);
  }

  if (ts.isIdentifier(expr)) {
    const symbol = checker.getShorthandAssignmentValueSymbol?.(expr) ?? checker.getSymbolAtLocation(expr);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return resolveMapSpecObject(checker, declaration.initializer);
    }

    const variable = findVariableDeclaration(expr.getSourceFile(), expr.text, expr.getStart(expr.getSourceFile()));
    if (variable?.initializer) return resolveMapSpecObject(checker, variable.initializer);
  }

  return null;
}

function readRule(node: ts.Expression): Omit<MapRuleInfo, "key"> | null {
  const expr = skipExpression(node);

  if (ts.isObjectLiteralExpression(expr)) {
    return readRuleObject(expr);
  }

  if (ts.isCallExpression(expr) && expr.arguments[0]) {
    const from = stringValue(expr.arguments[0]);
    const metadata = expr.arguments.length > 2 ? expr.arguments[2] : expr.arguments[1];
    if (!from) return null;
    return { from, ...readMetadata(metadata) };
  }

  return null;
}

function readRuleObject(object: ts.ObjectLiteralExpression): Omit<MapRuleInfo, "key"> | null {
  const from = readStringProperty(object, "from");
  if (!from) return null;

  return {
    from,
    dtoOrigin: readStringProperty(object, "dtoOrigin") ?? undefined,
    domainDescription: readStringProperty(object, "domainDescription") ?? undefined,
    dtoDescription: readStringProperty(object, "dtoDescription") ?? undefined,
  };
}

function readMetadata(node: ts.Expression | undefined): Partial<Omit<MapRuleInfo, "key" | "from">> {
  const expr = node ? skipExpression(node) : null;
  if (!expr || !ts.isObjectLiteralExpression(expr)) return {};

  return {
    dtoOrigin: readStringProperty(expr, "dtoOrigin") ?? undefined,
    domainDescription: readStringProperty(expr, "domainDescription") ?? undefined,
    dtoDescription: readStringProperty(expr, "dtoDescription") ?? undefined,
  };
}

function readStringProperty(object: ts.ObjectLiteralExpression, name: string): string | null {
  const prop = object.properties.find(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) && propertyName(item.name) === name
  );
  return prop ? stringValue(prop.initializer) : null;
}

export function skipExpression(node: ts.Expression): ts.Expression {
  let expr = node;
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function stringValue(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function findVariableDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
  before: number
): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null;

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.getStart(sourceFile) < before
    ) {
      found = node;
    }
    node.forEachChild(visit);
  };

  visit(sourceFile);
  return found;
}

function emitRuntimeSpecText(specObject: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): string {
  const properties: string[] = [];

  for (const prop of specObject.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;

    const key = propertyName(prop.name);
    const ruleText = emitRuntimeRuleText(prop.initializer, sourceFile);
    if (key && ruleText) properties.push(`${JSON.stringify(key)}:${ruleText}`);
  }

  return `{${properties.join(",")}}`;
}

function emitRuntimeRuleText(node: ts.Expression, sourceFile: ts.SourceFile): string | null {
  const expr = skipExpression(node);

  if (ts.isObjectLiteralExpression(expr)) {
    return transpileExpressionText(expr, sourceFile);
  }

  if (!ts.isCallExpression(expr) || !expr.arguments[0]) return null;

  const from = stringValue(expr.arguments[0]);
  if (!from) return null;

  const secondArgument = expr.arguments[1] ? skipExpression(expr.arguments[1]) : undefined;
  const hasTransform = expr.arguments.length > 2 || isFunctionLikeExpression(secondArgument);
  const fields = [`from:${JSON.stringify(from)}`];

  if (hasTransform && expr.arguments[1]) {
    fields.push(`transform:${transpileExpressionText(expr.arguments[1], sourceFile)}`);
  }

  const metadata = hasTransform ? expr.arguments[2] : expr.arguments[1];
  if (metadata) {
    fields.push(`...${transpileExpressionText(metadata, sourceFile)}`);
  }

  return `{${fields.join(",")}}`;
}

function isFunctionLikeExpression(node: ts.Expression | undefined): boolean {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function transpileExpressionText(expression: ts.Expression, sourceFile: ts.SourceFile): string {
  const marker = "__smartSchemaConverterSpec";
  const output = ts.transpileModule(`const ${marker} = ${expression.getText(sourceFile)};`, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText.trim();
  const prefix = `const ${marker} = `;

  return output.startsWith(prefix) ? output.slice(prefix.length).replace(/;$/, "") : expression.getText(sourceFile);
}
