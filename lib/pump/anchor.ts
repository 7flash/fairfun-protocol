import { createHash } from 'crypto';

export function accountDiscriminator(name: string) {
    return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}
