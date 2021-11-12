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
// to the processing time it saves. if the css file is written to since we last
// cached it, we invalidate and re-parse
const cache: Record<
  string,
  {
    classnames: Set<string>;
    lastRead: number;
  }
> = {};
/**
 * classnamesFromCssFile returns the css classnames defined in the given file
 */
const classnamesFromCssFile = (path: string) => {
  if (!fs.existsSync(path)) {
    return new Set<string>();
  }
  const stats = fs.statSync(path);
  if (!cache[path] || cache[path].lastRead < stats.mtimeMs) {
    const data = fs.readFileSync(path);
    const ast = csstree.parse(data.toString());
    cache[path] = {
      classnames: new Set<string>(),
      lastRead: stats.mtimeMs,
    };
    csstree.walk(ast, (node: any) => {
      // handles raw definitions
      if (node.type === "ClassSelector") {
        cache[path].classnames.add(node.name);
      }
      // handles @imports
      if (node.type === "Atrule" && node.prelude?.type === "AtrulePrelude") {
        const importLoc = node.prelude.children.first();
        if (importLoc?.type === "String") {
          toAbsolutePaths(importLoc.value.replace(/"/g, ""), path).forEach(
            (p) =>
              // ♪ recursion dont hurt me ♪
              classnamesFromCssFile(p).forEach((c) =>
                cache[path].classnames.add(c)
              )
          );
        }
      }
    });
  }
  return cache[path].classnames;
};

/**
 * toAbsolutePaths returns an array of possible locations for a file. for
 * relative paths, this array will only have a single element, but absolute
 * paths are more ambiguous and could be defined in different locations
 * according to tsconfig
 * for example:
 * toAbsolutePaths("./abcd.css", "a/b/c/d") => ["a/b/c/d/abcd.css"]
 * toAbsolutePaths("../../abcd.css", "a/b/c/d") => ["a/b/abcd.css"]
 * toAbsolutePaths("a/b/abcd.css", "a/b/c/d") => ["node_modules/a/b/abcd.css", "client/a/b/abcd.css", ...]
 */
const toAbsolutePaths = (relativePath: string, fromPath: string) => {
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
