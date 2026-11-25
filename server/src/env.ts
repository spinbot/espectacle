// Settings from the environment: ESPECTACLE_<NAME>, or the TREELIGHTS_<NAME> spelling from before the
// rename, so an older docker-compose.yml keeps working.
export function env(name: string): string | undefined {
  return process.env[`ESPECTACLE_${name}`] ?? process.env[`TREELIGHTS_${name}`];
}
