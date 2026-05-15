declare module 'bs58' {
    const bs58: {
        decode(input: string): Uint8Array;
        encode(input: Uint8Array | Buffer): string;
    };

    export default bs58;
}
