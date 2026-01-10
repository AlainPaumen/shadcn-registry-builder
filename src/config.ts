import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE_NAME = "shadcn-registry-builder.json";
const DEFAULT_ALLOWED_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx"];
const DEFAULT_SKIP_DIRECTORIES = ["node_modules", ".git", "dist", ".dist"];

type RawKnownRegistry = Record<string, string>;

export type RawConfig = {
    allowed_extensions?: string[];
    skip_directories?: string[];
    knownRegistries?: RawKnownRegistry[];
};

export type KnownRegistryEntry = {
    prefix: string;
    normalizedPrefix: string;
    type: string;
};

export type NormalizedConfig = {
    allowedExtensions: Set<string>;
    skipDirectories: Set<string>;
    knownRegistries: KnownRegistryEntry[];
};

export async function loadConfig(
    rootPath: string,
    fallbackPath?: string
): Promise<NormalizedConfig> {
    const primaryResult = await readConfigAt(rootPath);
    if (primaryResult) {
        return primaryResult;
    }

    if (fallbackPath && path.resolve(fallbackPath) !== path.resolve(rootPath)) {
        const fallbackResult = await readConfigAt(fallbackPath);
        if (fallbackResult) {
            return fallbackResult;
        }
    }

    return normalizeConfig({});
}

async function readConfigAt(rootPath: string): Promise<NormalizedConfig | null> {
    const configPath = path.join(rootPath, CONFIG_FILE_NAME);
    try {
        const raw = await readFile(configPath, "utf8");
        const parsed = JSON.parse(raw) as RawConfig;
        return normalizeConfig(parsed);
    } catch (error) {
        if (isMissingFileError(error)) {
            return null;
        }
        throw new Error(
            `Failed to read configuration at ${configPath}: ${(error as Error).message}`
        );
    }
}

export async function resolveTargetPath(inputPath?: string): Promise<string> {
    if (!inputPath) {
        throw new Error(
            "Path argument is required. Usage: npm start -- <directory-to-scan>"
        );
    }

    const target = path.resolve(process.cwd(), inputPath);
    try {
        const stats = await stat(target);
        if (!stats.isDirectory()) {
            throw new Error(`Provided path is not a directory: ${target}`);
        }
    } catch (error) {
        if (isMissingFileError(error)) {
            throw new Error(`Path does not exist: ${target}`);
        }
        throw error;
    }

    return target;
}

function normalizeConfig(config: RawConfig): NormalizedConfig {
    return {
        allowedExtensions: new Set(
            normalizeExtensions(config.allowed_extensions ?? DEFAULT_ALLOWED_EXTENSIONS)
        ),
        skipDirectories: new Set(
            (config.skip_directories ?? DEFAULT_SKIP_DIRECTORIES).map((dir) =>
                dir.toLowerCase()
            )
        ),
        knownRegistries: normalizeKnownRegistries(config.knownRegistries ?? []),
    };
}

function normalizeExtensions(values: string[]): string[] {
    return values.map((value) => {
        const trimmed = value.trim().toLowerCase();
        if (trimmed.startsWith(".")) {
            return trimmed;
        }
        return `.${trimmed}`;
    });
}

function normalizeKnownRegistries(entries: RawKnownRegistry[]): KnownRegistryEntry[] {
    const normalized: KnownRegistryEntry[] = [];

    entries.forEach((entry) => {
        Object.entries(entry).forEach(([prefix, type]) => {
            const trimmedPrefix = prefix.trim();
            const trimmedType = type.trim();
            if (!trimmedPrefix || !trimmedType) {
                return;
            }

            const normalizedPrefix = ensureTrailingSlash(
                normalizePathForComparison(trimmedPrefix)
            );

            normalized.push({
                prefix: trimmedPrefix,
                normalizedPrefix,
                type: trimmedType,
            });
        });
    });

    return normalized;
}

function normalizePathForComparison(value: string): string {
    let normalized = value.replace(/\\/g, "/");
    if (normalized.startsWith("./")) {
        normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/^\/+/, "");
    return normalized;
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : `${value}/`;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
    return Boolean(
        error && typeof error === "object" && "code" in error && error.code === "ENOENT"
    );
}
