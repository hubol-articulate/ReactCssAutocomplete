import * as vscode from "vscode";
import * as fs from "fs";
import * as csstree from "css-tree";

const rootFolder =
  vscode.workspace.workspaceFolders &&
  vscode.workspace.workspaceFolders[0]?.uri.path;

const extensionConfig = vscode.workspace.getConfiguration(
  "reactcssautocomplete"
);
const globalCss = extensionConfig.get<string[]>("globalCss") || [];
const moduleSearchPaths =
  extensionConfig.get<string[]>("moduleSearchPaths") || [];

// a mapping of filenames to the css classes they define. this is cached so we
// don't repeatedly parse css files. this shouldn't consume much memory compared
// to the processing time it saves
const filesToClassnames: Record<string, Set<string>> = {};
// storing missing files so we don't repeatedly look them up
const missingFiles = new Set<string>();
// returns the css classnames defined in the given file
export const classnamesFromCssFile = (path: string) => {
  if (missingFiles.has(path) || !fs.existsSync(path)) {
    missingFiles.add(path);
    return new Set<string>();
  }
  if (!filesToClassnames[path]) {
    const data = fs.readFileSync(path);
    const ast = csstree.parse(data.toString());
    filesToClassnames[path] = new Set<string>();
    csstree.walk(ast, (node) => {
      // handles raw definitions
      if (node.type === "ClassSelector") {
        filesToClassnames[path].add(node.name);
      }
      // handles @imports
      if (node.type === "Atrule" && node.prelude?.type === "AtrulePrelude") {
        const importLoc = node.prelude.children.first();
        if (importLoc?.type === "String") {
          toAbsolutePaths(importLoc.value.replace(/"/g, ""), path).forEach(
            (p) =>
              // ♪ recursion dont hurt me ♪
              classnamesFromCssFile(p).forEach((c) =>
                filesToClassnames[path].add(c)
              )
          );
        }
      }
    });
  }
  return filesToClassnames[path];
};

// returns an array of possible locations for a file. for relative paths, this
// array will only have a single element, but absolute paths are more ambiguous
// and could be defined in different locations according to tsconfig
export const toAbsolutePaths = (relativePath: string, fromPath: string) => {
  const parts = fromPath.split("/");
  parts.pop();
  if (relativePath.startsWith("./")) {
    return [parts.join("/") + "/" + relativePath.replace("./", "")];
  } else if (relativePath.startsWith("../")) {
    do {
      relativePath = relativePath.substring(3);
      parts.pop();
    } while (relativePath.startsWith("../"));
    return [parts.join("/") + "/" + relativePath];
  }
  return moduleSearchPaths.map((pre) => pre + "/" + relativePath);
};

const cssImportsFromDocument = (document: string) => {
  const imports: string[] = [];
  document.split("\n").forEach((l) => {
    if (l.includes("import") && l.includes(".css")) {
      imports.push(l.substring(l.indexOf('"') + 1, l.lastIndexOf('"')));
    }
  });
  return imports;
};

const globalClassnames = new Set<string>();
globalCss.forEach((f) => {
  if (rootFolder) {
    classnamesFromCssFile(rootFolder + "/" + f).forEach((c) =>
      globalClassnames?.add(c)
    );
  }
});
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { pattern: "**/*.tsx" },
      {
        provideCompletionItems(
          document: vscode.TextDocument,
          position: vscode.Position
        ) {
          try {
            const linePrefix = document
              .lineAt(position)
              .text.substr(0, position.character);
            if (!linePrefix.includes("className")) {
              return undefined;
            }
            // check that exactly a single " exists between className and our
            // cursor
            const spaceBetween = linePrefix.substring(
              linePrefix.indexOf("className")
            );
            if ((spaceBetween.match(/"/g) || []).length > 1) {
              return undefined;
            }

            const suggestions: vscode.CompletionItem[] = [];
            if (globalClassnames) {
              globalClassnames.forEach((c) =>
                suggestions.push(
                  new vscode.CompletionItem(
                    c,
                    vscode.CompletionItemKind.Keyword
                  )
                )
              );
            }
            cssImportsFromDocument(document.getText()).forEach((f) => {
              toAbsolutePaths(f, document.fileName).forEach((p) => {
                classnamesFromCssFile(p).forEach((c) => {
                  suggestions.push(
                    new vscode.CompletionItem(
                      c,
                      vscode.CompletionItemKind.Keyword
                    )
                  );
                });
              });
            });
            return suggestions;
          } catch (e: unknown) {
            vscode.window.showErrorMessage((e as any).stack);
          }
          return [];
        },
      },
      '"', // triggered whenever a " is being typed
      " " // triggered whenever a space is being typed, since classnames are often not alone
    )
  );
}

export function deactivate() {}
