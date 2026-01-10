import path from "node:path";

import type { DirectoryNode, FileNode, ImportEntry } from "../types";
import { isRelativeModule } from "./import-parser";
import type { ScanOptions } from "./types";

export function annotateImportCounts(
    root: DirectoryNode,
    rootPath: string,
    options: ScanOptions = {}
): void {
    const absoluteRoot = path.resolve(rootPath);
    const fileNodes = collectFileNodes(root);
    const lookup = buildFileLookup(fileNodes);

    fileNodes.forEach((file) => {
        if (!file.meta) {
            file.meta = { size: 0, modifiedAt: "" };
        }
        file.meta.importCount = 0;
    });

    fileNodes.forEach((file) => {
        file.imports.forEach((entry) => {
            const targets = resolveImportTargets(
                file,
                entry,
                absoluteRoot,
                options
            );
            targets.forEach((target) => {
                const targetNode = findFileNodeByRelativePath(lookup, target);

                if (targetNode) {
                    const current = targetNode.meta.importCount ?? 0;
                    targetNode.meta.importCount = current + 1;
                }
            });
        });
    });
}

export function getComponentCandidates(root: DirectoryNode): string[] {
    return collectFileNodes(root)
        .filter((file) => (file.meta?.importCount ?? 0) === 0)
        .map((file) => file.path);
}

export function buildFileIndex(root: DirectoryNode): Map<string, FileNode> {
    return buildFileLookup(collectFileNodes(root));
}

function collectFileNodes(root: DirectoryNode): FileNode[] {
    const files: FileNode[] = [];

    const walk = (node: DirectoryNode | FileNode) => {
        if (node.type === "file") {
            files.push(node);
            return;
        }

        node.children.forEach((child) => {
            if (child.type === "file") {
                files.push(child);
            } else {
                walk(child);
            }
        });
    };

    walk(root);
    return files;
}

function buildFileLookup(files: FileNode[]): Map<string, FileNode> {
    const map = new Map<string, FileNode>();

    files.forEach((file) => {
        const normalized = normalizeLookupPath(file.path);
        registerPathVariants(map, normalized, file);
    });

    return map;
}

function registerPathVariants(
    map: Map<string, FileNode>,
    normalizedPath: string,
    file: FileNode
) {
    map.set(normalizedPath, file);

    const withoutExt = stripExtension(normalizedPath);
    if (withoutExt !== normalizedPath) {
        map.set(withoutExt, file);
    }

    const withoutIndex = stripIndex(withoutExt);
    if (withoutIndex && withoutIndex !== withoutExt) {
        map.set(withoutIndex, file);
    }
}

export function findFileNodeByRelativePath(
    lookup: Map<string, FileNode>,
    relativePath: string
): FileNode | undefined {
    const normalized = normalizeLookupPath(relativePath);
    return (
        lookup.get(normalized) ??
        lookup.get(stripExtension(normalized)) ??
        lookup.get(stripIndex(normalized))
    );
}

export function resolveImportTargets(
    file: FileNode,
    entry: ImportEntry,
    rootPath: string,
    options: ScanOptions
): string[] {
    const targets = new Set<string>();
    const packageRoot = options.packageRoot ?? rootPath;

    if (entry.resolvedPaths?.length) {
        entry.resolvedPaths.forEach((resolved) => {
            const candidateAbs = path.resolve(packageRoot, resolved);
            const relative = path.relative(rootPath, candidateAbs);
            targets.add(relative);
        });
    }

    if (entry.moduleSpecifier && isRelativeModule(entry.moduleSpecifier)) {
        const importerAbs = path.resolve(rootPath, file.path);
        const importerDir = path.dirname(importerAbs);
        const candidateAbs = path.resolve(importerDir, entry.moduleSpecifier);
        targets.add(path.relative(rootPath, candidateAbs));
    }

    return Array.from(targets);
}

function normalizeLookupPath(value: string): string {
    let normalized = value.replace(/\\/g, "/");
    normalized = normalized.replace(/^\.\//, "");
    normalized = normalized.replace(/^\/+/g, "");
    return normalized;
}

function stripExtension(value: string): string {
    const lastDot = value.lastIndexOf(".");
    if (lastDot <= 0) {
        return value;
    }
    return value.slice(0, lastDot);
}

function stripIndex(value: string): string {
    if (value.endsWith("/index")) {
        return value.slice(0, -"/index".length);
    }
    return value;
}
