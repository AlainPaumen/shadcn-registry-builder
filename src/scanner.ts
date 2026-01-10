import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import type { KnownRegistryEntry, NormalizedConfig } from "./config";
import type { PackageInfo } from "./package-info";
import type { PathMapping } from "./tsconfig-info";
import type {
    DirectoryNode,
    FileNode,
    ImportEntry,
    PackageReference,
    TreeNode,
} from "./types";

export type ScanOptions = {
    packageInfo?: PackageInfo | null;
    pathMappings?: PathMapping[];
    packageRoot?: string;
};

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

    const imports = extractImports(
        source,
        options.packageInfo,
        options.pathMappings,
        options.packageRoot,
        config.knownRegistries
    );

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

function extractImports(
    sourceFile: ts.SourceFile,
    packageInfo?: PackageInfo | null,
    pathMappings?: PathMapping[],
    packageRoot?: string,
    knownRegistries?: KnownRegistryEntry[]
): ImportEntry[] {
    const imports: ImportEntry[] = [];

    sourceFile.forEachChild((node) => {
        if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile)
            );

            const moduleName = getModuleSpecifier(node);
            const depInfo = moduleName
                ? resolvePackageMatch(moduleName, packageInfo)
                : undefined;
            const aliasInfo = moduleName
                ? resolvePathAlias(moduleName, pathMappings, packageRoot)
                : undefined;
            const fileDependency =
                moduleName && isRelativeModule(moduleName) ? moduleName : undefined;
            const registryDependency =
                aliasInfo?.paths && aliasInfo.paths.length
                    ? findRegistryDependency(aliasInfo.paths, knownRegistries)
                    : undefined;

            imports.push({
                line: line + 1,
                statement: node.getText(sourceFile).trim(),
                moduleSpecifier: moduleName ?? undefined,
                fileDependency,
                dependency: depInfo?.dependency,
                devDependency: depInfo?.devDependency,
                pathAlias: aliasInfo?.alias,
                resolvedPaths: aliasInfo?.paths,
                registryDependency,
            });
        }
    });

    return imports;
}

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

function collectFileNodes(root: TreeNode): FileNode[] {
    const files: FileNode[] = [];

    function walk(node: TreeNode): void {
        if (node.type === "file") {
            files.push(node);
            return;
        }

        node.children.forEach((child) => walk(child));
    }

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

function getModuleSpecifier(
    node: ts.ImportDeclaration | ts.ImportEqualsDeclaration
): string | null {
    if (ts.isImportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        return ts.isStringLiteralLike(specifier) ? specifier.text : null;
    }

    if (
        ts.isImportEqualsDeclaration(node) &&
        node.moduleReference &&
        ts.isExternalModuleReference(node.moduleReference)
    ) {
        const expression = node.moduleReference.expression;
        return expression && ts.isStringLiteralLike(expression)
            ? expression.text
            : null;
    }

    return null;
}

function resolvePackageMatch(
    moduleName: string,
    packageInfo?: PackageInfo | null
): { dependency?: PackageReference; devDependency?: PackageReference } | undefined {
    if (!packageInfo) {
        return undefined;
    }

    const packageName = getPackageName(moduleName);
    if (!packageName) {
        return undefined;
    }

    if (packageInfo.dependencies[packageName]) {
        return {
            dependency: {
                name: packageName,
                version: packageInfo.dependencies[packageName],
                type: "dependency",
            },
        };
    }

    if (packageInfo.devDependencies[packageName]) {
        return {
            devDependency: {
                name: packageName,
                version: packageInfo.devDependencies[packageName],
                type: "devDependency",
            },
        };
    }

    return undefined;
}

function getPackageName(moduleName: string): string | null {
    if (!moduleName) {
        return null;
    }

    if (moduleName.startsWith("@")) {
        const segments = moduleName.split("/");
        if (segments.length >= 2) {
            return `${segments[0]}/${segments[1]}`;
        }
        return null;
    }

    const [pkg] = moduleName.split("/");
    return pkg || null;
}

function resolvePathAlias(
    moduleName: string,
    pathMappings?: PathMapping[],
    packageRoot?: string
): { alias: string; paths: string[] } | undefined {
    if (!pathMappings?.length) {
        return undefined;
    }

    for (const mapping of pathMappings) {
        const match = matchAlias(moduleName, mapping.alias);
        if (!match) {
            continue;
        }

        const resolvedPaths = mapping.targets.map((target) =>
            target.includes("*") ? target.replace(/\*/g, match) : target
        );
        const normalized = packageRoot
            ? resolvedPaths.map((target) => path.relative(packageRoot, target))
            : resolvedPaths;

        return {
            alias: mapping.alias,
            paths: normalized,
        };
    }

    return undefined;
}

function matchAlias(moduleName: string, alias: string): string | null {
    if (!alias.includes("*")) {
        return moduleName === alias ? "" : null;
    }

    const [prefix, suffix] = alias.split("*");
    if (!moduleName.startsWith(prefix)) {
        return null;
    }

    if (suffix && !moduleName.endsWith(suffix)) {
        return null;
    }

    return moduleName.slice(prefix.length, moduleName.length - suffix.length);
}

function findRegistryDependency(
    resolvedPaths: string[],
    knownRegistries?: KnownRegistryEntry[]
): PackageReference | undefined {
    if (!knownRegistries?.length || !resolvedPaths.length) {
        return undefined;
    }

    for (const resolvedPath of resolvedPaths) {
        const normalizedPath = normalizeRelativePath(resolvedPath);
        for (const registry of knownRegistries) {
            if (!normalizedPath.startsWith(registry.normalizedPrefix)) {
                continue;
            }

            const remainder = normalizedPath.slice(registry.normalizedPrefix.length);
            if (!remainder) {
                continue;
            }

            return {
                name: remainder.replace(/^\/+/, ""),
                type: registry.type,
            };
        }
    }

    return undefined;
}

function normalizeRelativePath(value: string): string {
    let normalized = value.replace(/\\/g, "/");
    if (normalized.startsWith("./")) {
        normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/^\/+/, "");
    return normalized.endsWith("/") ? normalized : normalized;
}

function normalizeLookupPath(value: string): string {
    let normalized = value.replace(/\\/g, "/");
    normalized = normalized.replace(/^\.\//, "");
    normalized = normalized.replace(/^\/+/, "");
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

function isRelativeModule(moduleSpecifier: string): boolean {
    return moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../");
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
