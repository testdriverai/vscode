import * as vscode from 'vscode';
import { parseDocument, isMap, isSeq, Pair, Node, Document } from 'yaml';
import { getPackagePath } from './npm';
import Ajv from 'ajv';

const findNodeByPath = (doc: Document.Parsed, path: string): any => {
  const parts = path.split('/').slice(1); // Remove leading slash
  let currentNode: any = doc.contents;

  for (const part of parts) {
    if (isMap(currentNode)) {
      const pair = currentNode.items.find((item: any) => item.key?.value === part);
      currentNode = pair?.value;
    } else if (isSeq(currentNode)) {
      const index = parseInt(part, 10);
      currentNode = currentNode.items[index];
    } else {
      return null;
    }
  }

  return currentNode?.cstNode ?? null; // Return CST node, which has `range`
};

export function validate(context: vscode.ExtensionContext) {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('yaml');
  const ajv = new Ajv({ allowUnionTypes: true, allErrors: true });

  const validateYaml = async (document: vscode.TextDocument) => {
    if (!document.uri.fsPath.includes('/testdriver/')) return;
    if (document.languageId !== 'yaml') return;

    const schemaPath = vscode.Uri.file(`${getPackagePath()}/schema.json`);
    const schema = JSON.parse(await vscode.workspace.fs.readFile(schemaPath).then(buffer => buffer.toString()));

    const text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    try {
      const doc = parseDocument(text, { keepSourceTokens: true });
      const jsonData = doc.toJSON();
      const valid = ajv.validate(schema, jsonData);

      if (!valid && ajv.errors) {
        for (const error of ajv.errors) {
          const cstNode = findNodeByPath(doc, error.instancePath || '');

          if (cstNode?.range) {
            const [startOffset, endOffset] = cstNode.range;
            const startPos = document.positionAt(startOffset);
            const endPos = document.positionAt(endOffset);

            diagnostics.push(new vscode.Diagnostic(
              new vscode.Range(startPos, endPos),
              `${error.instancePath || '/'} ${error.message ?? 'Validation error'}`,
              vscode.DiagnosticSeverity.Error
            ));
          } else {
            diagnostics.push(new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 1),
              `${error.instancePath || '/'} ${error.message ?? 'Validation error (no position info)'}`,
              vscode.DiagnosticSeverity.Error
            ));
          }
        }
      }
    } catch (err: any) {
      diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 1),
        `YAML Parse error: ${err.message}`,
        vscode.DiagnosticSeverity.Error
      ));
    }

    diagnosticCollection.set(document.uri, diagnostics);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(validateYaml),
    vscode.workspace.onDidChangeTextDocument(e => validateYaml(e.document)),
    vscode.workspace.onDidSaveTextDocument(validateYaml),
    diagnosticCollection
  );

  vscode.workspace.textDocuments.forEach(validateYaml);
}
