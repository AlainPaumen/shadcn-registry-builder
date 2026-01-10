import type { NormalizedConfig } from "../config";
import type { PackageInfo } from "../package-info";
import type { PathMapping } from "../tsconfig-info";

export type ScanOptions = {
    packageInfo?: PackageInfo | null;
    pathMappings?: PathMapping[];
    packageRoot?: string;
};

export type ScanContext = {
    rootPath: string;
    config: NormalizedConfig;
    options: ScanOptions;
};
