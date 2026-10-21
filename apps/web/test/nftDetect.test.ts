import { describe, expect, it } from 'vitest';
import { getAddress, toFunctionSelector } from 'viem';
import { codeHasFunction, minimalProxyTarget, parseMintTarget } from '../src/lib/nft/detect';

const A = '0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763';
const CHECKSUM = getAddress(A);

describe('paste a link', () => {
  it('bare address → network unknown (searched on every chain)', () => {
    expect(parseMintTarget(A)).toEqual({ kind: 'address', network: null, address: CHECKSUM });
    expect(parseMintTarget(`  ${A}\n`)).toMatchObject({ kind: 'address', network: null });
  });
  it('OpenSea / Magic Eden item and collection links', () => {
    expect(parseMintTarget(`https://opensea.io/item/monad/${A}/12`)).toMatchObject({ network: 'monad' });
    expect(parseMintTarget(`https://opensea.io/assets/base/${A}/1`)).toMatchObject({ network: 'base' });
    expect(parseMintTarget(`magiceden.io/collections/monad/${A}`)).toMatchObject({ network: 'monad' });
    expect(parseMintTarget(`https://magiceden.io/mint-terminal/ethereum/${A}`)).toMatchObject({
      network: 'ethereum',
    });
    expect(parseMintTarget('https://opensea.io/collection/chog-genesis')).toEqual({
      kind: 'slug',
      slug: 'chog-genesis',
    });
    expect(parseMintTarget('https://opensea.io/collection/chog-genesis/overview?x=1')).toMatchObject({
      slug: 'chog-genesis',
    });
  });
  it('explorer links use the explorer host', () => {
    expect(parseMintTarget(`https://basescan.org/address/${A}`)).toMatchObject({ network: 'base' });
    expect(parseMintTarget(`https://etherscan.io/token/${A}`)).toMatchObject({ network: 'ethereum' });
  });
  it('junk → null', () => {
    expect(parseMintTarget('hello')).toBeNull();
    expect(parseMintTarget('https://example.com/collection/x')).toBeNull();
  });
});

describe('bytecode function detection', () => {
  const sel = (s: string) => toFunctionSelector(`function ${s}`).slice(2);
  it('finds PUSH4 selectors', () => {
    const code = `0x6080604052${'63' + sel('mint(uint256)')}1461001c57${'63' + sel('price()')}14`;
    expect(codeHasFunction(code, 'mint(uint256)')).toBe(true);
    expect(codeHasFunction(code, 'price()')).toBe(true);
    expect(codeHasFunction(code, 'publicMint(uint256)')).toBe(false);
  });
  it('reads EIP-1167 minimal proxies', () => {
    const impl = 'bebebebebebebebebebebebebebebebebebebebe';
    expect(
      minimalProxyTarget(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`)?.toLowerCase(),
    ).toBe(`0x${impl}`);
    expect(minimalProxyTarget('0x6080')).toBeNull();
  });
});
