export interface FrontendWatchCommand {
    directory: string;
    args: string[];
}

interface PackageJson {
    scripts?: Record<string, string>;
}

const nestedFrontendDirectories = ['src-admin', 'src-tab'];

/**
 * Determine how to start a persistent build for a nested adapter frontend.
 *
 * Modern ioBroker adapters commonly keep Vite projects in src-admin/src-tab
 * without exposing the legacy watch:react script in the adapter root.
 */
export function getNestedFrontendWatchCommand(
    directory: string,
    packageJson: PackageJson,
): FrontendWatchCommand | undefined {
    const scripts = packageJson.scripts ?? {};

    for (const scriptName of ['watch:react', 'watch:parcel', 'watch']) {
        if (scripts[scriptName]) {
            return {
                directory,
                args: ['--prefix', directory, 'run', scriptName],
            };
        }
    }

    // Vite supports watch mode on its build command. Reuse the package's build
    // script so all project-specific flags and configuration remain intact.
    if (scripts.build && /(?:^|\s|&&|\|\|)vite(?:\.cmd)?\s+build(?:\s|$)/i.test(scripts.build)) {
        return {
            directory,
            args: ['--prefix', directory, 'run', 'build', '--', '--watch'],
        };
    }

    return undefined;
}

export function getNestedFrontendDirectories(): readonly string[] {
    return nestedFrontendDirectories;
}
