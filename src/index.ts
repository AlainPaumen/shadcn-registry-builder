import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import { loadConfig, resolveTargetPath } from "./config";
import { findNearestPackageJson } from "./package-info";
import {
    annotateImportCounts,
    buildFileIndex,
    findFileNodeByRelativePath,
    getComponentCandidates,
    resolveImportTargets,
    scanDirectory,
    type ScanOptions,
} from "./scanner";
import { loadTsconfigInfo } from "./tsconfig-info";
import type { FileNode, PackageReference } from "./types";

async function main() {
    const target = await resolveTargetPath(process.argv[2]);
    const config = await loadConfig(target, process.cwd());
    const packageInfo = await findNearestPackageJson(target);
    logPackageInfo(packageInfo);
    const packageRoot = packageInfo ? path.dirname(packageInfo.path) : target;
    const tsconfigInfo = await loadTsconfigInfo(target);
    logTsconfigInfo(tsconfigInfo, packageRoot);

    const scanOptions: ScanOptions = {
        packageInfo,
        pathMappings: tsconfigInfo.pathMappings,
        packageRoot,
    };

    const result = await scanDirectory(target, target, config, scanOptions);
    annotateImportCounts(result, target, scanOptions);
    const fileIndex = buildFileIndex(result);
    const componentCandidates = getComponentCandidates(result);

    console.log(JSON.stringify(result, null, 2));
    await runComponentExplorer(
        componentCandidates,
        fileIndex,
        target,
        scanOptions
    );
}

function logPackageInfo(packageInfo: Awaited<ReturnType<typeof findNearestPackageJson>>) {
    if (!packageInfo) {
        console.log("No package.json found above target directory.");
        return;
    }

    console.log(`Using package.json at ${packageInfo.path}`);
    const deps = Object.keys(packageInfo.dependencies).sort();
    const devDeps = Object.keys(packageInfo.devDependencies).sort();

    console.log("Dependencies:", deps.length ? deps.join(", ") : "(none)");
    console.log("DevDependencies:", devDeps.length ? devDeps.join(", ") : "(none)");
}

function logTsconfigInfo(
    tsconfigInfo: Awaited<ReturnType<typeof loadTsconfigInfo>>,
    packageRoot: string
) {
    if (tsconfigInfo.files.length === 0) {
        console.log("No tsconfig files found above target directory.");
        return;
    }

    console.log("Using tsconfig files:");
    tsconfigInfo.files.forEach((file) =>
        console.log(` - ${path.relative(packageRoot, file)}`)
    );

    if (tsconfigInfo.pathMappings.length) {
        console.log("Resolved path aliases:");
        tsconfigInfo.pathMappings.forEach((mapping) => {
            const targets = mapping.targets
                .map((target) => path.relative(packageRoot, target))
                .join(", ");
            console.log(` - ${mapping.alias} -> ${targets}`);
        });
    } else {
        console.log("No path aliases defined in located tsconfig files.");
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error("Failed to scan directory:", error);
        process.exitCode = 1;
    });
}

async function runComponentExplorer(
    candidates: string[],
    fileIndex: Map<string, FileNode>,
    rootPath: string,
    options: ScanOptions
) {
    console.log("\nComponent Candidates");
    if (candidates.length === 0) {
        console.log("  (none)");
        return;
    }

    candidates
        .slice()
        .sort((a, b) => a.localeCompare(b))
        .forEach((candidate, index) =>
            console.log(`  [${index + 1}] ${candidate}`)
        );
    console.log("  [q] Quit");

    const rl = readline.createInterface({ input, output });

    try {
        while (true) {
            const answer = (
                await rl.question(
                    "Select a component to inspect (number or q to exit): "
                )
            )
                .trim()
                .toLowerCase();

            if (answer === "" || answer === "q") {
                console.log("Exiting component candidates explorer.");
                break;
            }

            const index = Number.parseInt(answer, 10);
            if (!Number.isFinite(index) || index < 1 || index > candidates.length) {
                console.log("Invalid selection. Please choose a listed number or q.");
                continue;
            }

            const candidatePath = candidates[index - 1];
            printComponentReport(
                candidatePath,
                fileIndex,
                rootPath,
                options
            );
        }
    } finally {
        rl.close();
    }
}

function printComponentReport(
    candidatePath: string,
    fileIndex: Map<string, FileNode>,
    rootPath: string,
    options: ScanOptions
) {
    const node = findFileNodeByRelativePath(fileIndex, candidatePath);
    if (!node) {
        console.log(`\nUnable to locate component: ${candidatePath}`);
        return;
    }

    console.log(`\nComponent Candidates Report: ${node.path}`);
    printDependencyTree(
        node,
        fileIndex,
        rootPath,
        options,
        new Set<string>(),
        ""
    );
}

function printDependencyTree(
    node: FileNode,
    fileIndex: Map<string, FileNode>,
    rootPath: string,
    options: ScanOptions,
    visited: Set<string>,
    indent: string
) {
    console.log(`${indent}${node.path}`);
    if (visited.has(node.path)) {
        console.log(`${indent}  (already visited)`);
        return;
    }
    visited.add(node.path);

    const sectionIndent = `${indent}  `;
    printPackageSection(
        "Dependencies",
        collectPackageReferences(node, "dependency"),
        sectionIndent
    );
    printPackageSection(
        "DevDependencies",
        collectPackageReferences(node, "devDependency"),
        sectionIndent
    );
    printPackageSection(
        "RegistryDependencies",
        collectPackageReferences(node, "registryDependency"),
        sectionIndent
    );

    const fileDependencies = collectFileDependencies(
        node,
        fileIndex,
        rootPath,
        options
    );

    if (fileDependencies.length) {
        console.log(`${sectionIndent}FileDependencies:`);
        fileDependencies.forEach((child) => {
            if (visited.has(child.path)) {
                console.log(`${sectionIndent}  - ${child.path} (already visited)`);
            } else {
                printDependencyTree(
                    child,
                    fileIndex,
                    rootPath,
                    options,
                    visited,
                    `${sectionIndent}  `
                );
            }
        });
    } else {
        console.log(`${sectionIndent}FileDependencies: (none)`);
    }

    visited.delete(node.path);
}

function printPackageSection(
    title: string,
    items: string[],
    indent: string
) {
    if (items.length === 0) {
        console.log(`${indent}${title}: (none)`);
        return;
    }

    console.log(`${indent}${title}:`);
    items.forEach((item) => console.log(`${indent}  - ${item}`));
}

function collectPackageReferences(
    file: FileNode,
    key: "dependency" | "devDependency" | "registryDependency"
): string[] {
    const map = new Map<string, string>();

    file.imports.forEach((entry) => {
        const ref = entry[key];
        if (ref) {
            map.set(ref.name + (ref.version ?? ref.type ?? ""), formatPackageRef(ref, key));
        }
    });

    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
}

function formatPackageRef(
    ref: PackageReference,
    key: "dependency" | "devDependency" | "registryDependency"
): string {
    if (key === "registryDependency") {
        return `${ref.name} [${ref.type ?? "registry"}]`;
    }

    return ref.version ? `${ref.name}@${ref.version}` : ref.name;
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

    return Array.from(nodes.values()).sort((a, b) => a.path.localeCompare(b.path));
}
