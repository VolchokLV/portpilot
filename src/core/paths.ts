import path from 'path';
import os from 'os';

// Everything PortPilot writes outside the config file lives here.
// PORTPILOT_HOME overrides it (used by tests).
export const PORTPILOT_DIR = process.env.PORTPILOT_HOME || path.join(os.homedir(), '.portpilot');

export const PID_DIR = path.join(PORTPILOT_DIR, 'pids');
export const LOG_DIR = path.join(PORTPILOT_DIR, 'logs');
export const CERTS_DIR = path.join(PORTPILOT_DIR, 'certs');
export const BIN_DIR = path.join(PORTPILOT_DIR, 'bin');
