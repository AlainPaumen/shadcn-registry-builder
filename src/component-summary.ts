import path from "node:path";

import {
    findFileNodeByRelativePath,
    resolveImportTargets,
    type ScanOptions,
} from "./scanner";
import type { FileNode, PackageReference } from "./types";

export type RegistryFileEntry = {
    path: string;
    type: "registry:file" | "registry:component" | "registry:lib";
    target: string;
};

export type ComponentSummaryResult = {
    candidatePath: string;
    node: FileNode;
    componentPath: string;
    dependencies: string[];
    registryDependencies: string[];
    fileDependencies: string[];
    files: RegistryFileEntry[];
};

type ComponentSummary = {
    dependencies: Set<string>;
    registryDependencies: Set<string>;
    fileDependencies: Set<string>;
};

export function formatFileDependencyPath(absolutePath: string, rootPath: string): string {
    const normalized = absolutePath.replace(/\\/g, "/");
    const marker = "/src/";
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex !== -1) {
        return `.${normalized.slice(markerIndex)}`;
    }

    const relative = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
    return relative || ".";
}

export function summarizeComponent(
    candidatePath: string,
    fileIndex: Map<string, FileNode>,
    rootPath: string,
    options: ScanOptions
): ComponentSummaryResult | null {
    const node = findFileNodeByRelativePath(fileIndex, candidatePath);
    if (!node) {
        return null;
    }

    const summary = buildComponentSummary(node, fileIndex, rootPath, options);
    const componentPath = formatFileDependencyPath(path.join(rootPath, candidatePath), rootPath);
    const fileDependenciesSet = new Set<string>([
        componentPath,
        ...summary.fileDependencies,
    ]);
    const fileDependencies = toSortedArray(fileDependenciesSet);

    return {
        candidatePath,
        node,
        componentPath,
        dependencies: toSortedArray(summary.dependencies),
        registryDependencies: toSortedArray(summary.registryDependencies),
        fileDependencies,
        files: buildFileEntries(fileDependencies),
    };
}

function toSortedArray(values: Set<string>): string[] {
    return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function buildFileEntries(items: string[]): RegistryFileEntry[] {
    return items.map((item) => {
        const target = item.startsWith(".") ? item.replace(".", "~") : item;
        const extension = path.extname(target);
        let type: RegistryFileEntry["type"] = "registry:file";

        if (extension === ".tsx" || extension === ".jsx") {
            type = item.endsWith(".content.ts") || item.endsWith(".content.js")
                ? "registry:file"
                : "registry:component";
        } else if (extension === ".ts" || extension === ".js") {
            type = item.endsWith(".content.ts") || item.endsWith(".content.js")
                ? "registry:file"
                : "registry:lib";
        }

        return {
            path: item,
            type,
            target,
        };
    });
}

function buildComponentSummary(
    node: FileNode,
    fileIndex: Map<string, FileNode>,
    rootPath: string,
    options: ScanOptions,
    summary: ComponentSummary = {
        dependencies: new Set(),
        registryDependencies: new Set(),
        fileDependencies: new Set(),
    },
    visited: Set<string> = new Set()
): ComponentSummary {
    if (visited.has(node.path)) {
        return summary;
    }

    visited.add(node.path);

    collectPackageReferences(node, "dependency").forEach((value) =>
        summary.dependencies.add(value)
    );
    collectPackageReferences(node, "devDependency").forEach((value) =>
        summary.dependencies.add(value)
    );
    collectPackageReferences(node, "registryDependency").forEach((value) =>
        summary.registryDependencies.add(value)
    );

    const fileDependencies = collectFileDependencies(node, fileIndex, rootPath, options);
    fileDependencies.forEach((child) => {
        const absolutePath = path.resolve(rootPath, child.path);
        const displayPath = formatFileDependencyPath(absolutePath, rootPath);
        summary.fileDependencies.add(displayPath);
        buildComponentSummary(child, fileIndex, rootPath, options, summary, visited);
    });

    return summary;
}

function collectPackageReferences(
    file: FileNode,
    key: "dependency" | "devDependency" | "registryDependency"
): string[] {
    const map = new Map<string, string>();

    file.imports.forEach((entry) => {
        const ref = entry[key];
        if (ref) {
            const display = formatPackageRef(ref, key);
            map.set(display, display);
        }
    });

    return Array.from(map.values());
}

function formatPackageRef(
    ref: PackageReference,
    key: "dependency" | "devDependency" | "registryDependency"
): string {
    if (key === "registryDependency") {
        const name =
            ref.name && ref.name.includes("/")
                ? ref.name.slice(ref.name.lastIndexOf("/") + 1)
                : ref.name;
        const type = ref.type ?? "";
        const result = type === "@shadcn/ui" ? `${name}` : `${type}/${name}`;
        const slashCount = (result.match(/\//g) || []).length;
        return slashCount > 1 ? result.replace("/", "-") : result;
    }

    return ref.name;
}

function collectFileDependencies(
    file: FileNode,
    fileIndex: Map<string, FileNode>,
    rootPath: string,
    options: ScanOptions
): FileNode[] {
    const nodes = new Map<string, FileNode>();

    file.imports.forEach((entry) => {
        const targets = resolveImportTargets(file, entry, rootPath, options);
        targets.forEach((target) => {
            const targetNode = findFileNodeByRelativePath(fileIndex, target);
            if (targetNode) {
                nodes.set(targetNode.path, targetNode);
            }
        });
    });

    const contentDeps = options.contentDependencyMap?.get(file.path) ?? [];
    contentDeps.forEach((contentPath) => {
        if (!nodes.has(contentPath)) {
            nodes.set(contentPath, createContentDependencyNode(contentPath));
        }
    });

    return Array.from(nodes.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function createContentDependencyNode(relativePath: string): FileNode {
    return {
        type: "file",
        name: path.basename(relativePath),
        path: relativePath,
        imports: [],
        meta: { size: 0, modifiedAt: "", importCount: 0 },
    };
}
