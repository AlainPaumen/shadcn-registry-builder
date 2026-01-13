import { constants as fsConstants } from "node:fs";
import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatFileDependencyPath } from "./component-summary";

type RegistryInfoItem = {
    name: string;
    title: string;
    description: string;
    type: string;
    path: string;
    categories: string[];
};

type RegistryInfo = {
    $schema: string;
    name: string;
    homepage: string;
    author: string;
    categorie: string[];
    items: RegistryInfoItem[];
};

export async function createRegistryInfo(targetPath: string, items: string[]): Promise<void> {
    const folderName = path.basename(targetPath);
    const componentPath = formatFileDependencyPath(targetPath, "./");
    const registryPath = path.join(targetPath, "registry.info");
    const backupPath = `${registryPath}.old`;

    let previousInfo: RegistryInfo | null = null;

    if (await fileExists(registryPath)) {
        if (await fileExists(backupPath)) {
            await unlink(backupPath);
        }
        await rename(registryPath, backupPath);
        previousInfo = await loadRegistryInfo(backupPath);
    }

    const baseInfo: RegistryInfo = {
        $schema: "https://ui.shadcn.com/schema/registry.json",
        name: `hoogin-${folderName}`,
        homepage: "https://hoogin.be",
        author: "Alain Paumen",
        categorie: [`${folderName}`],
        items: items.map((item) => {
            const formattedName = buildItemName(item);
            return {
                name: formattedName,
                title: formattedName,
                description: "",
                type: "registry:component",
                path: `${formatItemPath(item, componentPath)}`,
                categories: [formattedName],
            };
        }),
    };

    const mergedInfo = mergeRegistryInfo(baseInfo, previousInfo);
    await writeFile(registryPath, JSON.stringify(mergedInfo, null, 2));
    if (await fileExists(backupPath)) {
        await unlink(backupPath);
    }
    console.log(`registry.info written to ${registryPath}`);
}

function formatItemPath(item: string, componentPath: string): string {
    if (!item.includes("/")) {
        return `./${componentPath}`;
    }

    const lastSlashIndex = item.lastIndexOf("/");
    return lastSlashIndex === -1 ? `./${componentPath}` : `./${item.slice(0, lastSlashIndex)}`;
}

function buildItemName(item: string): string {
    const withoutExtension = item.replace(/\.(jsx?|tsx?)$/i, "");
    const withoutIndex = withoutExtension.endsWith("/index")
        ? withoutExtension.slice(0, -"/index".length)
        : withoutExtension;
    const lastSlashIndex = withoutIndex.lastIndexOf("/");
    return lastSlashIndex === -1 ? withoutIndex : withoutIndex.slice(lastSlashIndex + 1);
}

function mergeRegistryInfo(base: RegistryInfo, previous: RegistryInfo | null): RegistryInfo {
    if (!previous) {
        return base;
    }

    const mergedItems = mergeRegistryItems(base.items, previous.items);

    return {
        ...base,
        $schema: previous.$schema ?? base.$schema,
        name: previous.name ?? base.name,
        homepage: previous.homepage ?? base.homepage,
        author: previous.author ?? base.author,
        categorie: previous.categorie ?? base.categorie,
        items: mergedItems,
    };
}

function mergeRegistryItems(
    baseItems: RegistryInfoItem[],
    previousItems: RegistryInfoItem[]
): RegistryInfoItem[] {
    const previousMap = new Map(previousItems.map((item) => [item.name, item]));

    return baseItems.map((item) => {
        const previous = previousMap.get(item.name);
        if (!previous) {
            return item;
        }

        return {
            ...item,
            title: previous.title ?? item.title,
            description: previous.description ?? item.description,
            type: previous.type ?? item.type,
            path: previous.path ?? item.path,
            categories: previous.categories ?? item.categories,
        };
    });
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function loadRegistryInfo(filePath: string): Promise<RegistryInfo | null> {
    try {
        const raw = await readFile(filePath, "utf8");
        return JSON.parse(raw) as RegistryInfo;
    } catch (error) {
        console.error(`Failed to parse registry info at ${filePath}:`, error);
        return null;
    }
}
