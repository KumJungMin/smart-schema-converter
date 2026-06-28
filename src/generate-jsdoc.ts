import ts from "typescript";
import { findMapPolicyViolations, handleMapPolicyViolations, readMapRules } from "./emit-mapper.js";
import { parsePath } from "./path.js";

const JSDOC_CONTENT_WIDTH = 76;

export type GenerateJSDocOptions = {
  name?: string;
  mappingPolicy?: ts.Expression;
  policyMode?: "warn" | "error";
};

export function generateJSDocFromSpec(params: {
  checker: ts.TypeChecker;
  dtoType: ts.Type;
  domainType: ts.Type;
  specNode: ts.Expression;
  options?: GenerateJSDocOptions;
}): string {
  const checker = params.checker;
  const dtoName = params.dtoType.symbol?.name ?? "Dto";
  const name = params.options?.name ?? params.domainType.symbol?.name ?? "GeneratedDomain";
  const rules = readMapRules(checker, params.specNode);
  const lines = [`export interface ${name} {`];

  handleMapPolicyViolations(
    findMapPolicyViolations(checker, params.specNode, params.options?.mappingPolicy),
    params.options?.policyMode ?? "warn"
  );

  for (const prop of checker.getPropertiesOfType(params.domainType)) {
    const rule = rules.get(prop.name);
    if (!rule) {
      throw new Error(`[smart-schema-converter/generator] ${name}.${prop.name} is not mapped.`);
    }

    const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
    const domainType = declaration ? checker.getTypeOfSymbolAtLocation(prop, declaration) : checker.getAnyType();
    const dtoPathType = getTypeAtPath(checker, params.dtoType, rule.from);
    const description = getDomainDescription(checker, prop) ?? rule.domainDescription;
    const optional = (prop.getFlags() & ts.SymbolFlags.Optional) !== 0 ? "?" : "";

    lines.push("  /**");
    if (description) {
      pushJSDocText(lines, escapeComment(description));
      lines.push("   *");
    }
    pushJSDocBulletField(lines, "DTO", formatCodeSpan(`${dtoName}.${rule.from}`));
    if (rule.dtoDescription) {
      pushJSDocBulletField(lines, "DTO description", escapeComment(rule.dtoDescription));
    }
    pushJSDocBulletField(
      lines,
      "DTO type",
      formatCodeSpan(dtoPathType ? checker.typeToString(dtoPathType) : "unknown")
    );
    if (rule.dtoOrigin) pushJSDocBulletField(lines, "DTO origin", formatCodeSpan(rule.dtoOrigin));
    pushJSDocBulletField(lines, "Domain type", formatCodeSpan(checker.typeToString(domainType)));
    lines.push("   */");
    lines.push(`  ${emitPropertyName(prop.name)}${optional}: ${checker.typeToString(domainType)};`);
    lines.push("");
  }

  lines.push("}");
  return lines.join("\n");
}

function getTypeAtPath(checker: ts.TypeChecker, root: ts.Type, path: string): ts.Type | null {
  let current: ts.Type | null = root;

  for (const segment of parsePath(path)) {
    if (!current) return null;

    if (typeof segment === "number") {
      current =
        getArrayElementType(checker, current) ??
        (current as ts.TypeReference).typeArguments?.[segment] ??
        current.getNumberIndexType?.() ??
        null;
      continue;
    }

    const prop = checker.getPropertyOfType(current, segment);
    const declaration = prop?.valueDeclaration ?? prop?.declarations?.[0];
    current = prop && declaration ? checker.getTypeOfSymbolAtLocation(prop, declaration) : null;
  }

  return current;
}

function getArrayElementType(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  return (checker as { getElementTypeOfArrayType?: (type: ts.Type) => ts.Type | undefined })
    .getElementTypeOfArrayType?.(type) ?? null;
}

function emitPropertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function escapeComment(value: string): string {
  return value.replace(/\*\//g, "* /");
}

function getDomainDescription(checker: ts.TypeChecker, prop: ts.Symbol): string | null {
  const description = ts.displayPartsToString(prop.getDocumentationComment(checker)).trim();
  return description || null;
}

function pushJSDocBulletField(lines: string[], label: string, value: string): void {
  pushJSDocText(lines, `- ${label}: ${value}`, "", "  ");
}

function pushJSDocText(
  lines: string[],
  text: string,
  firstIndent = "",
  continuationIndent = firstIndent
): void {
  for (const line of wrapJSDocText(text, firstIndent, continuationIndent)) {
    lines.push(`   * ${line}`);
  }
}

function wrapJSDocText(text: string, firstIndent: string, continuationIndent: string): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [firstIndent.trimEnd()];

  const lines: string[] = [];
  let current = firstIndent;

  for (const word of words) {
    const candidate = current.trim().length ? `${current} ${word}` : `${current}${word}`;
    if (candidate.length <= JSDOC_CONTENT_WIDTH || !current.trim().length) {
      current = candidate;
      continue;
    }

    lines.push(current.trimEnd());
    current = `${continuationIndent}${word}`;
  }

  lines.push(current.trimEnd());
  return lines;
}

function formatCodeSpan(value: string): string {
  return `\`${escapeMarkdownCode(escapeComment(value))}\``;
}

function escapeMarkdownCode(value: string): string {
  return value.replace(/`/g, "\\`");
}
