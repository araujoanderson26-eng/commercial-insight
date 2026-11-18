export function passwordHash(value: string): Promise<string>;
export function passwordOK(value: string, encoded?: string): Promise<boolean>;
