import * as vscode from 'vscode';
import { parseDocument, isMap, isSeq, Node, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { getPackagePath } from './npm';
import Ajv from 'ajv';

const buildPathMap = (node: Node | null, path = '', map = new Map<string, Node>()): Map<string, Node> => {
  if (!node) {
    return map;
  }
  map.set(path, node);

  if (isMap(node)) {
    for (const item of (node as YAMLMap).items) {
      const key = item.key instanceof Scalar ? String(item.key.value) : String(item.key);
      const newPath = `${path}/${key}`;
      if (item.value && typeof item.value === 'object') {
        buildPathMap(item.value as Node, newPath, map);
      }
    }
  } else if (isSeq(node)) {
    (node as YAMLSeq).items.forEach((item, index) => {
      const newPath = `${path}/${index}`;
      if (item && typeof item === 'object') {
        map.set(newPath, item as Node);
        buildPathMap(item as Node, newPath, map);
      }
    });
  }

  return map;
};

export function validate(context: vscode.ExtensionContext) {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('yaml');
  const ajv = new Ajv({ allowUnionTypes: true, allErrors: true });

  const validateYaml = async (document: vscode.TextDocument) => {
    if (!document.uri.fsPath.includes('/testdriver/')) {
      return;
    }
    if (document.languageId !== 'yaml') {
      return;
    }

    const schemaPath = vscode.Uri.file(`${getPackagePath()}/schema.json`);
    const schema = JSON.parse(await vscode.workspace.fs.readFile(schemaPath).then(buffer => buffer.toString()));

    const text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    try {
      const doc = parseDocument(text, { keepSourceTokens: true });
      const pathMap = buildPathMap(doc.contents);
      const jsonData = doc.toJSON();
      const valid = ajv.validate(schema, jsonData);

      if (!valid && ajv.errors) {
        for (const error of ajv.errors) {
          let node = pathMap.get(error.instancePath || '');
          if (!node && error.instancePath) {
            const parentPath = error.instancePath.split('/').slice(0, -1).join('/');
            node = pathMap.get(parentPath || '');
          }
          const cstNode = (node as unknown as { cstNode?: { range?: [number, number] } })?.cstNode;

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
