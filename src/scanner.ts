import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import type { NormalizedConfig } from "./config";
import { extractImports } from "./scanner/import-parser";
import type { ScanOptions } from "./scanner/types";
import type { DirectoryNode, FileNode, TreeNode } from "./types";
export {
    annotateImportCounts,
    buildFileIndex,
    findFileNodeByRelativePath,
    getComponentCandidates,
    resolveImportTargets
} from "./scanner/file-graph";
export type { ScanOptions } from "./scanner/types";

export async function scanDirectory(
    currentPath: string,
    rootPath: string,
    config: NormalizedConfig,
    options: ScanOptions = {}
): Promise<DirectoryNode> {
    const dirEntries = await readdir(currentPath, { withFileTypes: true });

    const children = (
        await Promise.all(
            dirEntries.map(async (entry) => {
                const entryPath = path.join(currentPath, entry.name);

                if (entry.isDirectory()) {
                    if (config.skipDirectories.has(entry.name.toLowerCase())) {
                        return null;
                    }
                    return scanDirectory(entryPath, rootPath, config, options);
                }

                if (entry.isFile()) {
                    return inspectFile(entryPath, rootPath, config, options);
                }

                return null;
            })
        )
    )
        .filter((node): node is TreeNode => node !== null)
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
        type: "directory",
        name: path.basename(currentPath),
        path: relativePath(currentPath, rootPath),
        children,
    };
}

async function inspectFile(
    filePath: string,
    rootPath: string,
    config: NormalizedConfig,
    options: ScanOptions
): Promise<FileNode | null> {
    const extension = path.extname(filePath).toLowerCase();
    if (!config.allowedExtensions.has(extension)) {
        return null;
    }

    const fileContent = await readFile(filePath, "utf8");
    const fileStat = await stat(filePath);

    const source = ts.createSourceFile(
        filePath,
        fileContent,
        ts.ScriptTarget.Latest,
        true,
        determineScriptKind(extension)
    );

    const imports = extractImports(source, config.knownRegistries, options);

    return {
        type: "file",
        name: path.basename(filePath),
        path: relativePath(filePath, rootPath),
        imports,
        meta: {
            size: fileStat.size,
            modifiedAt: fileStat.mtime.toISOString(),
        },
    };
}

function determineScriptKind(extension: string): ts.ScriptKind {
    switch (extension) {
        case ".ts":
            return ts.ScriptKind.TS;
        case ".tsx":
            return ts.ScriptKind.TSX;
        case ".jsx":
            return ts.ScriptKind.JSX;
        default:
            return ts.ScriptKind.JS;
    }
}

function relativePath(targetPath: string, rootPath: string): string {
    const relPath = path.relative(rootPath, targetPath);
    return relPath === "" ? "." : relPath;
}
