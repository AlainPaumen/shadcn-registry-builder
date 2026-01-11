import path from "node:path";

import { Separator, select } from "@inquirer/prompts";
import { loadConfig, resolveTargetPath } from "./config";
import { createRegistryInfo } from "./createRegistryInfo";
import { findNearestPackageJson } from "./package-info";
import {
    annotateImportCounts,
    attachContentDependencies,
    buildFileIndex,
    findFileNodeByRelativePath,
    getComponentCandidates,
    resolveImportTargets,
    scanDirectory,
    type ScanOptions,
} from "./scanner";
import { loadTsconfigInfo } from "./tsconfig-info";
import type { FileNode, PackageReference } from "./types";

type CliArgs = {
    targetPath: string;
    verbose: boolean;
};

type LogFn = (...args: Parameters<typeof console.log>) => void;

let cliLog: LogFn = () => { };

function setVerboseLogging(enabled: boolean) {
    cliLog = enabled ? (...args) => console.log(...args) : () => { };
}

function parseCliArgs(argv: string[]): CliArgs {
    const args = argv.slice(2);
    if (
        args[0] &&
        [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(path.extname(args[0])) &&
        (args[0].includes(path.sep) || args[0].startsWith("."))
    ) {
        args.shift();
    }
    let verbose = false;
    let targetPath: string | undefined;

    for (const arg of args) {
        if (arg === "-v" || arg === "--verbose") {
            verbose = true;
            setVerboseLogging(true);
            continue;
        }

        if (!targetPath) {
            targetPath = arg;
            continue;
        }

        throw new Error(`Unexpected argument: ${arg}`);
    }

    if (!targetPath) {
        throw new Error(
            "Path argument is required. Usage: npm start -- [-v] <directory-to-scan>"
        );
    }

    return { targetPath, verbose };
}

async function main() {
    setVerboseLogging(false);
    const { targetPath, verbose } = parseCliArgs(process.argv);
    const target = await resolveTargetPath(targetPath);
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
    attachContentDependencies(result, scanOptions);
    const fileIndex = buildFileIndex(result);
    const componentCandidates = getComponentCandidates(result);

    cliLog("\nFiles Index:");
    cliLog(JSON.stringify(result, null, 2));
    await runComponentExplorer(
        componentCandidates,
        fileIndex,
        target,
        scanOptions
    );
}

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

function logPackageInfo(packageInfo: Awaited<ReturnType<typeof findNearestPackageJson>>) {
    if (!packageInfo) {
        cliLog("No package.json found above target directory.");
        return;
    }

    cliLog(`Using package.json at ${packageInfo.path}`);
    const deps = Object.keys(packageInfo.dependencies).sort();
    const devDeps = Object.keys(packageInfo.devDependencies).sort();

    cliLog("\nDependencies:", deps.length ? deps.join(", ") : "(none)");
    cliLog("\nDevDependencies:", devDeps.length ? devDeps.join(", ") : "(none)");
}

function logTsconfigInfo(
    tsconfigInfo: Awaited<ReturnType<typeof loadTsconfigInfo>>,
    packageRoot: string
) {
    if (tsconfigInfo.files.length === 0) {
        cliLog("\nNo tsconfig files found above target directory.");
        return;
    }

    cliLog("\nUsing tsconfig files:");
    tsconfigInfo.files.forEach((file) =>
        cliLog(` - ${path.relative(packageRoot, file)}`)
    );

    if (tsconfigInfo.pathMappings.length) {
        cliLog("\nResolved path aliases:");
        tsconfigInfo.pathMappings.forEach((mapping) => {
            const targets = mapping.targets
                .map((target) => path.relative(packageRoot, target))
                .join(", ");
            cliLog(` - ${mapping.alias} -> ${targets}`);
        });
    } else {
        cliLog("\nNo path aliases defined in located tsconfig files.");
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
    cliLog("\nComponent Candidates");
    if (candidates.length === 0) {
        cliLog("  (none)");
        return;
    }

    const sortedCandidates = candidates.slice().sort((a, b) => a.localeCompare(b));

    while (true) {
        const answer = await select<string | null>({
            message: "Select a component to inspect (choose Exit to finish):",
            choices: [
                ...sortedCandidates.map((candidate) => ({
                    name: candidate,
                    value: candidate,
                })),
                new Separator(),
                { name: "Create registry.info file", value: "createRegistryInfo" },
                { name: "Exit", value: null },
                new Separator(),
            ],
            pageSize: Math.min(sortedCandidates.length + 1, 20),
        }).catch((error) => {
            if (error instanceof Error && error.name === "ExitPromptError") {
                return null;
            }
            throw error;
        });

        if (!answer) {
            cliLog("Exiting component candidates explorer.");
            break;
        }

        switch (answer) {
            case "createRegistryInfo":
                createRegistryInfo(rootPath, sortedCandidates);
                break;
            default:
                printComponentReport(answer, fileIndex, rootPath, options);
        }
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
    let componentFile = new Set<string>();
    componentFile.add(formatFileDependencyPath(path.join(rootPath, candidatePath), rootPath));
    const summary = buildComponentSummary(node, fileIndex, rootPath, options);

    // Add component file to file dependencies 
    let allFileDependencies = new Set([...componentFile, ...summary.fileDependencies]);
    const dependencies = printSummaryGroup("dependencies", summary.dependencies);
    const registryDependencies = printSummaryGroup("registryDependencies", summary.registryDependencies);
    const fileDependencies = printSummaryGroupFiles(allFileDependencies);
    const allResults = { ...dependencies, ...registryDependencies, ...fileDependencies };
    console.log(JSON.stringify(allResults, null, 2));
}

type ComponentSummary = {
    dependencies: Set<string>;
    registryDependencies: Set<string>;
    fileDependencies: Set<string>;
};

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

function printSummaryGroup(title: string, values: Set<string>) {
    const items = Array.from(values).sort((a, b) => a.localeCompare(b));

    if (!items.length) {
        return {};
    }
    return { [title]: items };
}

function printSummaryGroupFiles(values: Set<string>) {
    const items = Array.from(values).sort((a, b) => a.localeCompare(b));

    if (!items.length) {
        return {};
    }
    let files = items.map((item) => {
        const target = item.startsWith(".") ? item.replace(".", "~") : item;
        const extension = path.extname(target);
        let type = "registry:file";
        if (extension === ".tsx" || extension === ".jsx") {
            if (item.endsWith(".content.ts") || item.endsWith(".content.js")) {
                type = "registry:file";
            } else {
                type = "registry:component";
            }
        }
        if (extension === ".ts" || extension === ".js") {
            if (item.endsWith(".content.ts") || item.endsWith(".content.js")) {
                type = "registry:file";
            } else {
                type = "registry:lib";
            }
        }
        return {
            path: item,
            type: type,
            target: target
        }
    });
    return { "files": files };
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
        let result = "";
        const name =
            ref.name && ref.name.includes("/")
                ? ref.name.slice(ref.name.lastIndexOf("/") + 1)
                : ref.name;
        //return `${name} [${ref.type ?? "registry"}]`;
        let type = ref.type ?? "";
        result = (type === "@shadcn/ui") ? `${name}` : `${type}/${name}`;
        const slashCount = (result.match(/\//g) || []).length;
        if (slashCount > 1) {
            return result.replace('/', '-');
        }
        return result

    }

    //return ref.version ? `${ref.name}@${ref.version}` : ref.name;
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
