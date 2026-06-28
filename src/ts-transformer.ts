import ts from "typescript";
import { emitMapperFromSpec } from "./emit-mapper.js";

export type MapperTransformerOptions = {
  program: ts.Program;
};

export default function tsTransformer(options: MapperTransformerOptions): ts.TransformerFactory<ts.SourceFile> {
  const checker = options.program.getTypeChecker();

  return (context: ts.TransformationContext) => {
    const visit: ts.Visitor = (node: ts.Node): ts.Node => {
      if (
        ts.isCallExpression(node) &&
        isSupportedMakeMapperExpression(checker, node.expression, node.getSourceFile()) &&
        node.typeArguments?.length === 2 &&
        node.arguments[0]
      ) {
        const mapperCallOptions = readMapperCallOptions(node.arguments[1]);
        const mapper = emitMapperFromSpec({
          checker,
          domainType: checker.getTypeFromTypeNode(node.typeArguments[1]),
          specNode: node.arguments[0],
          sourceFile: node.getSourceFile(),
          options: {
            mappingPolicy: mapperCallOptions.policy,
            policyMode: mapperCallOptions.policyMode,
          },
        });

        if (mapper) return ts.factory.createIdentifier(mapper) as unknown as ts.Node;
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (sourceFile: ts.SourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };
}

function isSupportedMakeMapperExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  sourceFile: ts.SourceFile
): expression is ts.Identifier {
  if (!ts.isIdentifier(expression) || expression.text !== "makeMapper") return false;

  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol?.declarations?.length) return true;

  return symbol.declarations.some((declaration) => {
    if (ts.isImportSpecifier(declaration)) {
      return importModuleName(declaration) === "smart-schema-converter";
    }

    if (isAmbientFunctionDeclaration(declaration)) {
      return true;
    }

    return declaration.getSourceFile() !== sourceFile;
  });
}

function importModuleName(declaration: ts.ImportSpecifier): string | null {
  const importDeclaration = declaration.parent.parent.parent;
  return ts.isStringLiteral(importDeclaration.moduleSpecifier)
    ? importDeclaration.moduleSpecifier.text
    : null;
}

function isAmbientFunctionDeclaration(declaration: ts.Declaration): boolean {
  return (
    ts.isFunctionDeclaration(declaration) &&
    declaration.name?.text === "makeMapper" &&
    !declaration.body &&
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true
  );
}

function readMapperCallOptions(node: ts.Expression | undefined): {
  policy?: ts.Expression;
  policyMode?: "warn" | "error";
} {
  if (!node) return {};

  const expr = skipExpression(node);
  if (!ts.isObjectLiteralExpression(expr)) return {};

  return {
    policy: readExpressionProperty(expr, "policy"),
    policyMode: readPolicyMode(expr),
  };
}

function readExpressionProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const item of object.properties) {
    if (ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name) {
      return item.initializer;
    }
    if (ts.isShorthandPropertyAssignment(item) && item.name.text === name) {
      return item.name;
    }
  }
  return undefined;
}

function readPolicyMode(object: ts.ObjectLiteralExpression): "warn" | "error" | undefined {
  const mode = readExpressionProperty(object, "policyMode");
  return mode && ts.isStringLiteral(mode) && (mode.text === "warn" || mode.text === "error") ? mode.text : undefined;
}

function skipExpression(node: ts.Expression): ts.Expression {
  let expr = node;
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}
