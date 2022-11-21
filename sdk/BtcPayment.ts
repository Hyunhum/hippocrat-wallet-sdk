import * as bitcoin from 'bitcoinjs-lib';
import * as ecPair from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import * as wif from 'wif';
import BtcRpcNode from './BtcRpcNode.js';
import coinSelect from 'coinselect';
import * as liquid from 'liquidjs-lib';
import BtcSigner from './models/BtcSigner.js';
import BtcReceiver from './models/BtcReceiver.js';
import UTXO from './models/UTXO.js';
import BtcNetwork from './enums/BtcNetwork.js';
import BtcRpcUrl from './enums/BtcRpcUrl.js';

class BtcPayment {
    // Account to pay transaction
    static getBtcSigner = async (
      privateKey : Buffer, btcNetwork : BtcNetwork)
    : Promise<BtcSigner> => {
        /* wif stands for Wallet Import Format, 
           need to encode private key to import wallet */
        const wifEncodedKey : string = wif.encode(
            128 as number, privateKey, true as boolean
        );
        const keyPair : ecPair.ECPairInterface = ecPair.ECPairFactory(ecc)
        .fromWIF(
            wifEncodedKey
        );
        // change prefix for liquid
        if(btcNetwork === 'liquid' || 
        btcNetwork === 'liquid testnet') {
          keyPair.network.messagePrefix = "\x18Liquid Signed Message:\n";
          btcNetwork === 'liquid'?  
          keyPair.network.bech32 = "ex"
          : keyPair.network.bech32 = "tex";
        }
        // latest version: SegWit
        const payment : bitcoin.payments.Payment = bitcoin.payments.p2wpkh({ 
            pubkey: keyPair.publicKey as Buffer,
            network: 
                btcNetwork === "mainnet" ? 
                bitcoin.networks.bitcoin
                : btcNetwork === "testnet" ? 
                bitcoin.networks.testnet
                : btcNetwork === "liquid" ?
                liquid.networks.liquid
                : liquid.networks.testnet as bitcoin.networks.Network
            });
        return {
            payment,
            keyPair
        };
    }
    static registerDid = async (
      signer : BtcSigner, toAddressList : string[], didmsg : string) 
    : Promise<string> => {
        // signerUTXO to spend
        const btcRpcUrl : BtcRpcUrl = await this._getSignerNetwork(signer);
        const signerUTXOList : UTXO[] = await BtcRpcNode.getUTXOList(
          signer.payment.address as string, btcRpcUrl);
        // didOwnerList
        let receiverList : BtcReceiver[] = [];
        toAddressList.forEach(toAddress => {
          receiverList.push({address: toAddress, value: 1})
        });
        // get optimized transaction  
        const psbt : bitcoin.Psbt = await this._utxoOptimizer(
          signer, receiverList, signerUTXOList);
        // data to store for did
        const data : Buffer = Buffer.from(didmsg, 'utf8');
        const embed : bitcoin.payments.Payment = bitcoin.payments.embed(
          { data: [data] as Buffer[] });
        // add OP_RETURN(hipocrat did registry)
        psbt.addOutput({
          script: embed.output as Buffer,
          value: 0 as number
        } as bitcoin.PsbtTxOutput)
        // sign and broadcast tx
        return await this._signAndBroadcastTx(signer, psbt);
    }
    // segWitTransfer support 
    static segWitTransfer = async (
      signer : BtcSigner, receiverList : BtcReceiver[]) 
    : Promise<string> => {
        // signerUTXO to spend
        const btcRpcUrl : BtcRpcUrl = await this._getSignerNetwork(signer);
        const signerUTXOList : UTXO[] = await BtcRpcNode.getUTXOList(
          signer.payment.address as string, btcRpcUrl);
        // get optimized transaction  
        const psbt : bitcoin.Psbt = await this._utxoOptimizer(
          signer, receiverList, signerUTXOList);
        // sign and broadcast tx
        return await this._signAndBroadcastTx(signer, psbt);
    }
    // helper method to select UTXO and fee
    private static _utxoOptimizer = async(
      signer : BtcSigner, target : BtcReceiver[], signerUTXOList : UTXO[])
    : Promise<bitcoin.Psbt> => {
        /*
        satoshis per byte
        10 s/b enough for next block confirm
        need to increase when network traffic is anomal
        */
        const feeRate : number = 10;
        const selectedUTXO : any = coinSelect(signerUTXOList, target, feeRate);
        // .inputs and .outputs will be undefined if no solution was found
        if (!selectedUTXO.inputs || !selectedUTXO.outputs) return Promise.reject(
          new Error('No UTXO found for valid transaction'));
        // creation of psbt
        const psbt : bitcoin.Psbt = new bitcoin.Psbt({ 
          network: signer.payment.network as bitcoin.networks.Network });
        // add optimized input & ouput UTXO
        selectedUTXO.inputs.forEach((input : any) =>
          psbt.addInput({
            hash: input.txid as string | Buffer, // tx id
            index: input.vout as number, // output number of above tx hash
            witnessUtxo: {
              script: signer.payment.output as Buffer, // scriptPubKey
              value: input.value as number, // UTXO amount
            }
          } as bitcoin.PsbtTxInput)
        )
        selectedUTXO.outputs.forEach((output : any) => {
          // watch out, outputs may have been added that you need to provide
          // an output address/script for
          if (!output.address as boolean) {
            output.address = signer.payment.address as string;
          }
          psbt.addOutput({
            address: output.address as string,
            value: output.value as number,
          } as bitcoin.PsbtTxOutput)
        })        
        return psbt;
    }
    // helper method to sign and broadcast tx
    private static _signAndBroadcastTx = async(
      signer : BtcSigner,
      psbt : bitcoin.Psbt)
    : Promise<string> => {
      psbt.signAllInputs(
        signer.keyPair as ecPair.ECPairInterface
      );

      psbt.finalizeAllInputs() as bitcoin.Psbt;

      const tx : bitcoin.Transaction = psbt.extractTransaction();

      const btcRpcUrl : BtcRpcUrl = await this._getSignerNetwork(signer);

      return await BtcRpcNode.broadcastTx(
        tx.toHex() as string, btcRpcUrl
        ) as string;
    }
    // helper method to get network of signer
    private static _getSignerNetwork = async(
      signer: BtcSigner)
    : Promise<BtcRpcUrl> => {
      return signer.payment.network === bitcoin.networks.bitcoin ?
      BtcRpcUrl.Mainnet 
      : signer.payment.network === bitcoin.networks.testnet ? 
      BtcRpcUrl.Testnet 
      : signer.payment.network === liquid.networks.liquid ? 
      BtcRpcUrl.Liquid
      : BtcRpcUrl.Liquid_Testnet
    }
}

export default BtcPayment;