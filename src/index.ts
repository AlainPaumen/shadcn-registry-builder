import path from "node:path";

import { Separator, select } from "@inquirer/prompts";
import {
    summarizeComponent,
    type RegistryFileEntry
} from "./component-summary";
import { loadConfig, resolveTargetPath } from "./config";
import { createRegistryInfo } from "./createRegistryInfo";
import { findNearestPackageJson } from "./package-info";
import { generateRegistryJson } from "./registry-json";
import {
    annotateImportCounts,
    attachContentDependencies,
    buildFileIndex,
    getComponentCandidates,
    scanDirectory,
    type ScanOptions
} from "./scanner";
import { loadTsconfigInfo } from "./tsconfig-info";
import type { FileNode } from "./types";

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
            message: "Select a command or a component to inspect (choose Exit to finish):",
            choices: [
                { name: "1. Generate registry.info file", value: "createRegistryInfo" },
                { name: "2. Generate registry.json file", value: "generateRegistryJson" },
                { name: "Exit", value: null },
                new Separator(),
                ...sortedCandidates.map((candidate) => ({
                    name: candidate,
                    value: candidate,
                })),
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
                await createRegistryInfo(rootPath, sortedCandidates);
                break;
            case "generateRegistryJson":
                await generateRegistryJson(rootPath, sortedCandidates, fileIndex, options);
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
    const summary = summarizeComponent(candidatePath, fileIndex, rootPath, options);
    if (!summary) {
        console.log(`\nUnable to locate component: ${candidatePath}`);
        return;
    }

    console.log(`\nComponent Candidates Report: ${summary.node.path}`);
    const dependencies = printSummaryGroup("dependencies", summary.dependencies);
    const registryDependencies = printSummaryGroup(
        "registryDependencies",
        summary.registryDependencies
    );
    const fileDependencies = printSummaryGroupFiles(summary.files);
    const allResults = { ...dependencies, ...registryDependencies, ...fileDependencies };
    console.log(JSON.stringify(allResults, null, 2));
}

function printSummaryGroup(title: string, values: string[]) {
    if (!values.length) {
        return {};
    }
    const items = values.slice().sort((a, b) => a.localeCompare(b));
    return { [title]: items };
}

function printSummaryGroupFiles(files: RegistryFileEntry[]) {
    if (!files.length) {
        return {};
    }
    return { files };
}
