export interface SetupStepModule {
  run(args: string[]): Promise<void>;
}

export interface SetupStepDefinition {
  name: string;
  summary: string;
  load: () => Promise<SetupStepModule>;
}

const SETUP_STEPS: SetupStepDefinition[] = [
  {
    name: 'timezone',
    summary: 'Capture the host timezone for scheduled task alignment.',
    load: () => import('./timezone.js'),
  },
  {
    name: 'environment',
    summary: 'Inspect OS, runtimes, auth state, and existing NanoClaw data.',
    load: () => import('./environment.js'),
  },
  {
    name: 'container',
    summary: 'Select and configure the container runtime used by agents.',
    load: () => import('./container.js'),
  },
  {
    name: 'git-auth',
    summary:
      'Configure Git credential material that can be mounted for trusted turns.',
    load: () => import('./git-auth.js'),
  },
  {
    name: 'groups',
    summary: 'Prepare group folders and default local memory files.',
    load: () => import('./groups.js'),
  },
  {
    name: 'register',
    summary: 'Register channels and persist the initial group catalog.',
    load: () => import('./register.js'),
  },
  {
    name: 'mounts',
    summary: 'Configure additional mount allowlists for agent containers.',
    load: () => import('./mounts.js'),
  },
  {
    name: 'service',
    summary: 'Install or refresh the long-running host service.',
    load: () => import('./service.js'),
  },
  {
    name: 'verify',
    summary: 'Run an end-to-end installation health check.',
    load: () => import('./verify.js'),
  },
];

const stepRegistry = new Map(
  SETUP_STEPS.map((step) => [step.name, step] as const),
);

export function getSetupSteps(): SetupStepDefinition[] {
  return [...SETUP_STEPS];
}

export function getSetupStep(name: string): SetupStepDefinition | undefined {
  return stepRegistry.get(name);
}

export function formatSetupUsage(command = 'npx tsx setup/index.ts'): string {
  const lines = [`Usage: ${command} --step <name> [args...]`, '', 'Steps:'];

  for (const step of getSetupSteps()) {
    lines.push(`  ${step.name.padEnd(11)} ${step.summary}`);
  }

  lines.push('');
  lines.push('Flags:');
  lines.push('  --help, -h   Show this help text');
  lines.push('  --list       Show the available setup steps');

  return lines.join('\n');
}
