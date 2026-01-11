import path from "node:path";

import type { DirectoryNode, FileNode } from "../types";
import type { ContentFileInfo, ScanOptions } from "./types";

const CONTENT_FILE_PATTERN = /\.content\.(?:ts|tsx|js|jsx)$/i;

export function isContentFilePath(filePath: string): boolean {
    return CONTENT_FILE_PATTERN.test(filePath);
}

export function recordContentFile(
    filePath: string,
    rootPath: string,
    options: ScanOptions
): void {
    const relativePath = normalizePath(path.relative(rootPath, filePath));
    const info: ContentFileInfo = {
        path: relativePath,
        basePath: extractBasePath(relativePath),
        directory: normalizePath(path.dirname(relativePath)),
    };

    if (info.directory === "") {
        info.directory = ".";
    }

    if (!options.contentFiles) {
        options.contentFiles = [];
    }
    options.contentFiles.push(info);
}

export function attachContentDependencies(
    root: DirectoryNode,
    options: ScanOptions = {}
): void {
    const contentFiles = options.contentFiles ?? [];
    const fileNodes = collectFileNodes(root);
    const dependencyMap = new Map<string, string[]>();

    if (!contentFiles.length) {
        options.contentDependencyMap = dependencyMap;
        return;
    }

    const baseLookup = buildBaseLookup(fileNodes);
    const unmatched: ContentFileInfo[] = [];

    for (const content of contentFiles) {
        const normalizedBase = normalizePath(content.basePath);
        const matches = baseLookup.get(normalizedBase);

        if (matches?.length) {
            matches.forEach((node) => addDependency(dependencyMap, node.path, content.path));
        } else {
            unmatched.push(content);
        }
    }

    if (unmatched.length) {
        const zeroImportNodes = fileNodes.filter((node) => (node.meta?.importCount ?? 0) === 0);

        for (const content of unmatched) {
            const targets = findZeroImportTargets(content, zeroImportNodes);
            targets.forEach((node) => addDependency(dependencyMap, node.path, content.path));
        }
    }

    options.contentDependencyMap = dependencyMap;
}

function collectFileNodes(root: DirectoryNode): FileNode[] {
    const results: FileNode[] = [];

    const walk = (node: DirectoryNode | FileNode) => {
        if (node.type === "file") {
            results.push(node);
            return;
        }

        node.children.forEach((child) => {
            if (child.type === "file") {
                results.push(child);
            } else {
                walk(child);
            }
        });
    };

    walk(root);
    return results;
}

function buildBaseLookup(fileNodes: FileNode[]): Map<string, FileNode[]> {
    const lookup = new Map<string, FileNode[]>();

    fileNodes.forEach((node) => {
        const basePath = stripExtension(normalizePath(node.path));
        const list = lookup.get(basePath);
        if (list) {
            list.push(node);
        } else {
            lookup.set(basePath, [node]);
        }
    });

    return lookup;
}

function addDependency(map: Map<string, string[]>, filePath: string, contentPath: string): void {
    const existing = map.get(filePath);
    if (existing) {
        if (!existing.includes(contentPath)) {
            existing.push(contentPath);
        }
    } else {
        map.set(filePath, [contentPath]);
    }
}

function findZeroImportTargets(
    content: ContentFileInfo,
    zeroImportNodes: FileNode[]
): FileNode[] {
    const prefixes = buildDescendantPrefixes(content);
    if (!prefixes.length) {
        return [];
    }

    const matches: FileNode[] = [];

    zeroImportNodes.forEach((node) => {
        for (const prefix of prefixes) {
            if (prefix === "") {
                if (node.path.includes("/")) {
                    matches.push(node);
                    break;
                }
                continue;
            }

            if (
                node.path.startsWith(prefix) &&
                node.path.length > prefix.length &&
                node.path.slice(prefix.length).includes("/")
            ) {
                matches.push(node);
                break;
            }
        }
    });

    return matches;
}

function buildDescendantPrefixes(content: ContentFileInfo): string[] {
    const prefixes = new Set<string>();
    const normalizedBase = normalizePath(content.basePath);

    if (normalizedBase && normalizedBase !== ".") {
        const basePrefix = ensureTrailingSlash(normalizedBase);
        prefixes.add(basePrefix);

        if (normalizedBase.endsWith("/index")) {
            prefixes.add(ensureTrailingSlash(normalizedBase.slice(0, -"/index".length)));
        }
    }

    const directory = normalizePath(content.directory);
    if (directory && directory !== ".") {
        prefixes.add(ensureTrailingSlash(directory));
    } else {
        prefixes.add("");
    }

    return Array.from(prefixes);
}

function extractBasePath(relativePath: string): string {
    return normalizePath(relativePath).replace(/\.content\.(?:ts|tsx|js|jsx)$/i, "");
}

function stripExtension(value: string): string {
    const lastDot = value.lastIndexOf(".");
    return lastDot > 0 ? value.slice(0, lastDot) : value;
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, "/");
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : `${value}/`;
}
