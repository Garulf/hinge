const PACKAGE_NAME = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/** An Android package name, which is safe inside a phone shell command and a host file name; anything the phone reports is checked with this first. */
export function isPackageName(pkg: string): boolean {
  return PACKAGE_NAME.test(pkg);
}
