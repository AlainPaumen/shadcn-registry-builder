import path from "node:path";
import ts from "typescript";

export type PathMapping = {
    alias: string;
    targets: string[];
    sourceFile: string;
};

export type TsConfigInfo = {
    files: string[];
    pathMappings: PathMapping[];
};

const TSCONFIG_CANDIDATES = [
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
];

export async function loadTsconfigInfo(startDir: string): Promise<TsConfigInfo> {
    const files = await findTsconfigFiles(startDir);
    const pathMappings = files.flatMap((file) => extractPathMappings(file));

    return {
        files,
        pathMappings,
    };
}

async function findTsconfigFiles(startDir: string): Promise<string[]> {
    const matches = new Set<string>();

    for (const fileName of TSCONFIG_CANDIDATES) {
        const found = await findNearestFile(startDir, fileName);
        if (found) {
            matches.add(found);
        }
    }

    return Array.from(matches);
}

async function findNearestFile(
    startDir: string,
    fileName: string
): Promise<string | null> {
    let currentDir = startDir;

    while (true) {
        const candidate = path.join(currentDir, fileName);
        if (ts.sys.fileExists(candidate)) {
            const config = ts.readConfigFile(candidate, ts.sys.readFile);
            if (config.error) {
                throw new Error(
                    `Failed to read ${fileName} at ${candidate}: ${ts.flattenDiagnosticMessageText(
                        config.error.messageText,
                        "\n"
                    )}`
                );
            }
            return candidate;
        }

        const parent = path.dirname(currentDir);
        if (parent === currentDir) {
            break;
        }
        currentDir = parent;
    }

    return null;
}

function extractPathMappings(configPath: string): PathMapping[] {
    const parsed = ts.readConfigFile(configPath, ts.sys.readFile);
    if (parsed.error) {
        throw new Error(
            `Failed to read tsconfig at ${configPath}: ${ts.flattenDiagnosticMessageText(
                parsed.error.messageText,
                "\n"
            )}`
        );
    }

    const compilerOptions = parsed.config?.compilerOptions ?? {};
    const rawPaths = compilerOptions.paths ?? {};
    const baseUrl: string = compilerOptions.baseUrl ?? ".";
    const baseDir = path.resolve(path.dirname(configPath), baseUrl);

    return Object.entries<Record<string, string[]>>(rawPaths).flatMap(
        ([alias, targets]) => {
            if (!Array.isArray(targets) || targets.length === 0) {
                return [];
            }

            const resolvedTargets = targets.map((target) =>
                path.resolve(baseDir, target)
            );

            return [
                {
                    alias,
                    targets: resolvedTargets,
                    sourceFile: configPath,
                },
            ];
        }
    );
}
