import path from "node:path";
import ts from "typescript";

import type { KnownRegistryEntry } from "../config";
import type { PackageInfo } from "../package-info";
import type { ImportEntry, PackageReference } from "../types";
import type { ScanOptions } from "./types";

export function extractImports(
    sourceFile: ts.SourceFile,
    knownRegistries?: KnownRegistryEntry[],
    options: ScanOptions = {}
): ImportEntry[] {
    const imports: ImportEntry[] = [];

    sourceFile.forEachChild((node) => {
        if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile)
            );

            const moduleName = getModuleSpecifier(node);
            const depInfo = moduleName
                ? resolvePackageMatch(moduleName, options.packageInfo)
                : undefined;
            const aliasInfo = moduleName
                ? resolvePathAlias(
                    moduleName,
                    options.pathMappings,
                    options.packageRoot
                )
                : undefined;
            const fileDependency = moduleName && isRelativeModule(moduleName)
                ? moduleName
                : undefined;
            const registryDependency = aliasInfo?.paths?.length
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

export function isRelativeModule(moduleSpecifier: string): boolean {
    return moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../");
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
    pathMappings: ScanOptions["pathMappings"],
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
                name: remainder.replace(/^\/+/g, ""),
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
    normalized = normalized.replace(/^\/+/g, "");
    return normalized.endsWith("/") ? normalized : normalized;
}
