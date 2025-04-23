import * as vscode from 'vscode';
import { parseDocument, Document } from 'yaml';
import { getPackagePath } from './npm';
import Ajv from 'ajv';

const findNodeByPath = (doc: Document.Parsed, path: string): any => {


  const parts = path.split('/').slice(1); // Remove leading slash
  const node = doc.getIn(parts, true);   // Get original YAML node, not JSON-converted
  return node?.cstNode || node?.key?.cstNode || null;
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
      const doc = parseDocument(text, { keepCstNodes: true });

      const jsonData = doc.toJSON(); // Just for AJV
      const valid = ajv.validate(schema, jsonData);

      if (!valid && ajv.errors) {
        for (const error of ajv.errors) {
          const cstNode = findNodeByPath(doc, error.instancePath || '');
          const range = cstNode?.rangeAsLinePos;

          if (range) {
            const startPos = new vscode.Position(range.start.line, range.start.col);
            const endPos = new vscode.Position(range.end.line, range.end.col);

            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(startPos, endPos),
              error.instancePath + ' ' + error.message || 'Validation error',
              vscode.DiagnosticSeverity.Error
            );
            diagnostics.push(diagnostic);
          } else {
            diagnostics.push(new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 999),
              error.instancePath + ' ' + error.message || 'Validation error (no position info)',
              vscode.DiagnosticSeverity.Error
            ));
          }
        }
      }
    } catch (err: any) {
      diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 999),
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
