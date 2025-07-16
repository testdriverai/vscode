import * as vscode from 'vscode';

export class TestDiagnostics {
  private static collection = vscode.languages.createDiagnosticCollection('testdriver');

  static set(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) {
    this.collection.set(uri, diagnostics);
  }

  static clear(uri?: vscode.Uri) {
    if (uri) {
      this.collection.delete(uri);
    } else {
      this.collection.clear();
    }
  }
}
