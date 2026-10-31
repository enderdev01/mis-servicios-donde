const migrationDirectoryPattern = /^\d+_[a-z0-9_-]+$/;

export function isMigrationDirectoryName(name: string): boolean {
  return migrationDirectoryPattern.test(name);
}
