import * as ts from 'typescript';
import { runInNewContext } from 'vm';
import type { ImageSourceReference } from '../../editor/imageSourceReferences';

/**
 * Instrument a test-only copy of the scanner to count loop iterations and
 * sliced characters. Abort repeated suffix scans without a machine-speed gate.
 * This bounds the reported malformed-input regressions, not all parser work.
 */
export function createScannerWorkProbe(
  sourceText: string
): (source: string, budget: number) => { references: ImageSourceReference[]; work: number } {
  let work = 0;
  let maximumWork = 0;
  const charge = (amount: number): void => {
    work += amount;
    if (work > maximumWork) throw new Error('Image scanner exceeded its linear work budget');
  };
  const instrument: ts.TransformerFactory<ts.SourceFile> = context => {
    const factory = context.factory;
    const bodyWithCounter = (body: ts.Statement): ts.Block =>
      factory.createBlock(
        [
          factory.createExpressionStatement(
            factory.createCallExpression(factory.createIdentifier('__scanStep'), undefined, [])
          ),
          ...(ts.isBlock(body) ? body.statements : [body]),
        ],
        true
      );
    const visit: ts.Visitor = original => {
      const node = ts.visitEachChild(original, visit, context);
      if (ts.isForStatement(node))
        return factory.updateForStatement(
          node,
          node.initializer,
          node.condition,
          node.incrementor,
          bodyWithCounter(node.statement)
        );
      if (ts.isForOfStatement(node))
        return factory.updateForOfStatement(
          node,
          node.awaitModifier,
          node.initializer,
          node.expression,
          bodyWithCounter(node.statement)
        );
      if (ts.isForInStatement(node))
        return factory.updateForInStatement(
          node,
          node.initializer,
          node.expression,
          bodyWithCounter(node.statement)
        );
      if (ts.isWhileStatement(node))
        return factory.updateWhileStatement(node, node.expression, bodyWithCounter(node.statement));
      if (ts.isDoStatement(node))
        return factory.updateDoStatement(node, bodyWithCounter(node.statement), node.expression);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'slice'
      )
        return factory.createCallExpression(factory.createIdentifier('__scanSlice'), undefined, [
          node,
        ]);
      return node;
    };
    return source => ts.visitEachChild(source, visit, context);
  };
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    transformers: { before: [instrument] },
  });
  const scanner = {} as {
    findImageSourceReferences(source: string): ImageSourceReference[];
  };
  runInNewContext(compiled.outputText, {
    exports: scanner,
    require,
    __scanStep: () => charge(1),
    __scanSlice: (value: string) => {
      charge(value.length);
      return value;
    },
  });
  return (source, budget) => {
    work = 0;
    maximumWork = budget;
    const references = scanner.findImageSourceReferences(source);
    return { references, work };
  };
}
