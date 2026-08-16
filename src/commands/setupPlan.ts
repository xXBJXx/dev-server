export interface SetupPlanOptions {
    adapterName: string;
    adminPort: number;
    backupFile?: string;
    dependencies: Record<string, string>;
    force: boolean;
    hasBuildScript: boolean;
    profileName: string;
    profilePath: string;
    remote: boolean;
    setupExists: boolean;
    useSymlinks: boolean;
}

export interface SetupPlanStep {
    action: string;
    detail: string;
}

export function createSetupPlan(options: SetupPlanOptions): readonly SetupPlanStep[] {
    if (options.setupExists && !options.force) {
        return [
            {
                action: 'Stop',
                detail: `Profile "${options.profileName}" already exists; setup would require --force.`,
            },
        ];
    }

    const dependencyList = Object.entries(options.dependencies)
        .map(([name, version]) => `${name}@${version}`)
        .join(', ');
    const steps: SetupPlanStep[] = [];
    if (options.force) {
        steps.push({ action: 'Reset profile', detail: options.profilePath });
    }
    if (options.hasBuildScript) {
        steps.push({ action: 'Build adapter', detail: `iobroker.${options.adapterName}` });
    }
    steps.push({
        action: 'Create profile',
        detail: `${options.profilePath} (Admin http://127.0.0.1:${options.adminPort})`,
    });
    steps.push({ action: 'Verify ignores', detail: '.npmignore and .gitignore' });
    if (options.remote) {
        steps.push({
            action: 'Configure remote',
            detail: 'Prompt for SSH target, authenticate and prepare tunnels/files',
        });
    }
    steps.push({ action: 'Install core', detail: dependencyList || 'configured ioBroker dependencies' });
    if (options.backupFile) {
        steps.push({ action: 'Restore backup', detail: options.backupFile });
    }
    steps.push({
        action: 'Install adapter',
        detail: options.useSymlinks ? 'link local adapter directory' : 'pack and install local adapter',
    });
    steps.push({
        action: 'Configure instances',
        detail: 'upload Admin/adapter, create instances and disable adapter.0',
    });
    steps.push({
        action: 'Configure system',
        detail: 'local ports, diagnostics, license and beta repository defaults',
    });
    return steps;
}
