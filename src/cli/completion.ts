// Shell completion scripts. Project names come from "portpilot list --names" at completion time.

const COMMANDS = [
  'init', 'add', 'set', 'info', 'remove', 'list', 'start', 'stop', 'restart', 'open', 'logs',
  'proxy', 'status', 'config', 'sync', 'doctor', 'service', 'worktrees', 'ui', 'mcp',
  'completion', 'uninstall', 'help',
];
const PROJECT_COMMANDS = ['start', 'stop', 'restart', 'open', 'logs', 'remove', 'rm', 'info', 'set', 'worktrees'];
const SUBCOMMANDS: Record<string, string[]> = {
  proxy: ['start', 'stop', 'restart', 'status', 'logs'],
  service: ['install', 'uninstall', 'status'],
  completion: ['bash', 'zsh', 'fish', 'powershell'],
};

export const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
export type Shell = typeof SHELLS[number];

function bash(): string {
  const cases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => `    ${cmd}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") ) ;;`)
    .join('\n');
  return `# portpilot completion (bash). Add to ~/.bashrc:  eval "$(portpilot completion bash)"
_portpilot() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(' ')}" -- "$cur") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
    ${PROJECT_COMMANDS.join('|')}) COMPREPLY=( $(compgen -W "$(portpilot list --names 2>/dev/null)" -- "$cur") ) ;;
${cases}
  esac
}
complete -F _portpilot portpilot pp
`;
}

function zsh(): string {
  return `# portpilot completion (zsh). Add to ~/.zshrc:  eval "$(portpilot completion zsh)"
autoload -U +X bashcompinit && bashcompinit
${bash().split('\n').slice(1).join('\n')}`;
}

function fish(): string {
  const lines = ['# portpilot completion (fish). Save to ~/.config/fish/completions/portpilot.fish'];
  for (const bin of ['portpilot', 'pp']) {
    lines.push(`complete -c ${bin} -f -n '__fish_use_subcommand' -a '${COMMANDS.join(' ')}'`);
    lines.push(`complete -c ${bin} -f -n '__fish_seen_subcommand_from ${PROJECT_COMMANDS.join(' ')}' -a '(portpilot list --names 2>/dev/null)'`);
    for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
      lines.push(`complete -c ${bin} -f -n '__fish_seen_subcommand_from ${cmd}' -a '${subs.join(' ')}'`);
    }
  }
  return lines.join('\n') + '\n';
}

function powershell(): string {
  const subs = Object.entries(SUBCOMMANDS)
    .map(([cmd, values]) => `    '${cmd}' = @(${values.map((v) => `'${v}'`).join(', ')})`)
    .join('\n');
  return `# portpilot completion (PowerShell). Add to $PROFILE:  portpilot completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName portpilot, pp -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $commands = @(${COMMANDS.map((c) => `'${c}'`).join(', ')})
  $projectCommands = @(${PROJECT_COMMANDS.map((c) => `'${c}'`).join(', ')})
  $subcommands = @{
${subs}
  }
  if ($words.Count -le 1 -or ($words.Count -eq 2 -and $wordToComplete)) {
    $candidates = $commands
  } elseif ($projectCommands -contains $words[1]) {
    $candidates = @(portpilot list --names 2>$null)
  } elseif ($subcommands.ContainsKey($words[1])) {
    $candidates = $subcommands[$words[1]]
  } else {
    $candidates = @()
  }
  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

export function getCompletionScript(shell: Shell): string {
  switch (shell) {
    case 'bash':
      return bash();
    case 'zsh':
      return zsh();
    case 'fish':
      return fish();
    case 'powershell':
      return powershell();
  }
}
