import { constants as fsConstants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    summarizeComponent,
    type ComponentSummaryResult,
} from "./component-summary";
import type { ScanOptions } from "./scanner";
import type { FileNode } from "./types";

type RegistryConfig = {
    $schema?: string;
    name?: string;
    homepage?: string;
    author?: string;
    description?: string;
    categories?: string[];
    items?: RegistryConfigItem[];
    [key: string]: unknown;
};

type RegistryConfigItem = {
    name?: string;
    title?: string;
    description?: string;
    type?: string;
    //path?: string;
    categories?: string[];
    dependencies?: string[];
    registryDependencies?: string[];
    [key: string]: unknown;
};

type MetadataIndexes = {
    byPath: Map<string, RegistryConfigItem>;
    byName: Map<string, RegistryConfigItem>;
};

type RegistryOutputItem = {
    name: string;
    type: string;
    //path: string;
    files: ComponentSummaryResult["files"];
    title?: string;
    description?: string;
    categories?: string[];
    dependencies?: string[];
    registryDependencies?: string[];
};

export async function generateRegistryJson(
    rootPath: string,
    candidates: string[],
    fileIndex: Map<string, FileNode>,
    options: ScanOptions
): Promise<void> {
    const loadedConfig = await loadRegistryConfig(rootPath);
    if (!loadedConfig) {
        return;
    }
    const { data: registryData, sourcePath } = loadedConfig;
    const registryPath = path.join(rootPath, "registry.json");

    const metadata = buildMetadataIndexes(registryData.items ?? []);
    const topCategories = registryData.categories ?? [];
    const summaries = candidates
        .map((candidate) =>
            summarizeComponent(candidate, fileIndex, rootPath, options)
        )
        .filter((summary): summary is ComponentSummaryResult => summary !== null);

    if (!summaries.length) {
        console.warn("No components available to generate registry.json.");
        return;
    }

    const items = summaries.map((summary) => {
        const derivedPath = getComponentPath(summary.candidatePath);
        const normalizedKey = normalizeItemPath(derivedPath);
        const fallbackName = getComponentName(summary.candidatePath);
        const baseMeta =
            metadata.byPath.get(normalizedKey) ??
            metadata.byName.get(fallbackName) ??
            metadata.byName.get(summary.candidatePath);
        return buildRegistryItem(
            summary,
            derivedPath,
            fallbackName,
            baseMeta,
            topCategories
        );
    });
    const { categories: _ignoredCategories, ...registryRest } = registryData;
    const output: RegistryConfig = {
        ...registryRest,
        $schema: "https://ui.shadcn.com/schema/registry.json",
        items,
    };

    await writeFile(registryPath, JSON.stringify(output, null, 2));
    console.log(
        `Generated registry.json with ${items.length} items at ${registryPath} (metadata source: ${path.basename(
            sourcePath
        )})`
    );
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function buildMetadataIndexes(items: RegistryConfigItem[]): MetadataIndexes {
    const byPath = new Map<string, RegistryConfigItem>();
    const byName = new Map<string, RegistryConfigItem>();

    items.forEach((item) => {
        // if (item.path) {
        //     byPath.set(normalizeItemPath(item.path), item);
        // }
        if (item.name) {
            byName.set(item.name, item);
        }
    });

    return { byPath, byName };
}

function buildRegistryItem(
    summary: ComponentSummaryResult,
    derivedPath: string,
    fallbackName: string,
    baseMeta: RegistryConfigItem | undefined,
    topCategories: string[]
): RegistryOutputItem {
    const dependencies = mergeUnique(
        baseMeta?.dependencies ?? [],
        summary.dependencies
    );
    const registryDependencies = mergeUnique(
        baseMeta?.registryDependencies ?? [],
        summary.registryDependencies
    );
    const categories = mergeUnique(topCategories, baseMeta?.categories ?? []);

    return {
        name: baseMeta?.name ?? fallbackName,
        title: baseMeta?.title,
        description: baseMeta?.description,
        type: baseMeta?.type ?? "registry:component",
        //path: baseMeta?.path ?? derivedPath,
        categories: categories.length ? categories : undefined,
        dependencies: dependencies.length ? dependencies : undefined,
        registryDependencies: registryDependencies.length ? registryDependencies : undefined,
        files: summary.files,
    };
}

function mergeUnique(base: string[], additional: string[]): string[] {
    const values = new Set<string>([
        ...base,
        ...additional,
    ]);
    return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function getComponentPath(candidatePath: string): string {
    const normalized = normalizeItemPath(candidatePath.replace(/\\/g, "/"));
    const slashIndex = normalized.lastIndexOf("/");
    if (slashIndex === -1) {
        const withoutExtension = normalized.replace(/\.[^.]+$/, "");
        return `./${withoutExtension}`;
    }
    return `./${normalized.slice(0, slashIndex)}`;
}

function getComponentName(candidatePath: string): string {
    const normalized = normalizeItemPath(candidatePath.replace(/\\/g, "/"));
    const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
    return segment.replace(/\.[^.]+$/, "");
}

function normalizeItemPath(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

async function loadRegistryConfig(
    rootPath: string
): Promise<{ data: RegistryConfig; sourcePath: string } | null> {
    const candidates = ["registry.json", "registry.info"];
    for (const candidate of candidates) {
        const candidatePath = path.join(rootPath, candidate);
        if (await fileExists(candidatePath)) {
            try {
                const raw = await readFile(candidatePath, "utf8");
                return { data: JSON.parse(raw), sourcePath: candidatePath };
            } catch (error) {
                console.error(
                    `Failed to read or parse ${candidate} at ${candidatePath}:`,
                    error
                );
                return null;
            }
        }
    }

    console.error(
        `Unable to locate registry metadata in ${rootPath}. Looked for registry.json and registry.info.`
    );
    return null;
}
