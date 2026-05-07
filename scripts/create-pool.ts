
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.FairfunRewards as any;
  
  // GET MINT FROM COMMAND LINE
  const mintString = process.argv[2];
  if (!mintString) throw new Error("Please provide a token mint address");
  const tokenMint = new PublicKey(mintString);

  // 1. Derive PDAs
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("rewards_config")],
    program.programId
  );

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("rewards_pool"), tokenMint.toBuffer()],
    program.programId
  );

  const [treasury] = PublicKey.findProgramAddressSync(
    [Buffer.from("rewards_treasury"), tokenMint.toBuffer()],
    program.programId
  );

  console.log(`Registering pool for: ${mintString}`);
  
  const tx = await program.methods
    .registerPool(tokenMint)
    .accounts({
      admin: provider.wallet.publicKey,
      config: config,
      pool: pool,
      treasury: treasury,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Success! Transaction Signature:", tx);
}

main().catch(console.error);
