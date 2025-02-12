import assert from 'assert'

import { ethers } from 'ethers'
import {
  getChugSplashManagerProxyAddress,
  getConstructorArgs,
  chugsplashFetchSubtask,
  getMinimumCompilerInput,
  getCanonicalConfigArtifacts,
  INITIAL_CHUGSPLASH_MANAGER_ADDRESS,
  CHUGSPLASH_CONSTRUCTOR_ARGS,
  callWithTimeout,
  CanonicalChugSplashConfig,
  getImplAddress,
} from '@chugsplash/core'
import { EtherscanURLs } from '@nomiclabs/hardhat-etherscan/dist/src/types'
import {
  getVerificationStatus,
  EtherscanResponse,
  verifyContract,
  delay,
} from '@nomiclabs/hardhat-etherscan/dist/src/etherscan/EtherscanService'
import {
  toVerifyRequest,
  toCheckStatusRequest,
} from '@nomiclabs/hardhat-etherscan/dist/src/etherscan/EtherscanVerifyContractRequest'
import {
  retrieveContractBytecode,
  getEtherscanEndpoints,
} from '@nomiclabs/hardhat-etherscan/dist/src/network/prober'
import { Bytecode } from '@nomiclabs/hardhat-etherscan/dist/src/solc/bytecode'
import { buildContractUrl } from '@nomiclabs/hardhat-etherscan/dist/src/util'
import { getLongVersion } from '@nomiclabs/hardhat-etherscan/dist/src/solc/version'
import { encodeArguments } from '@nomiclabs/hardhat-etherscan/dist/src/ABIEncoder'
import { chainConfig } from '@nomiclabs/hardhat-etherscan/dist/src/ChainConfig'
import {
  ChugSplashManagerArtifact,
  ChugSplashBootLoaderArtifact,
  CHUGSPLASH_BOOTLOADER_ADDRESS,
  ChugSplashRegistryProxyArtifact,
  CHUGSPLASH_REGISTRY_PROXY_ADDRESS,
  ChugSplashManagerProxyArtifact,
  ROOT_CHUGSPLASH_MANAGER_PROXY_ADDRESS,
  ChugSplashRegistryArtifact,
  CHUGSPLASH_REGISTRY_ADDRESS,
  DefaultAdapterArtifact,
  DEFAULT_ADAPTER_ADDRESS,
  buildInfo,
  PROXY_INITIALIZER_ADDRESS,
  ProxyInitializerArtifact,
  DefaultUpdaterArtifact,
  DEFAULT_UPDATER_ADDRESS,
  OZTransparentAdapterArtifact,
  OZ_TRANSPARENT_ADAPTER_ADDRESS,
  OZUUPSUpdaterArtifact,
  OZ_UUPS_UPDATER_ADDRESS,
  OZUUPSAdapterArtifact,
  OZ_UUPS_ADAPTER_ADDRESS,
} from '@chugsplash/contracts'
import { request } from 'undici'
import { CompilerInput } from 'hardhat/types'

import { etherscanApiKey as apiKey, customChains } from './constants'

export interface EtherscanResponseBody {
  status: string
  message: string
  result: any
}

export const RESPONSE_OK = '1'

export const verifyChugSplashConfig = async (
  configUri: string,
  provider: ethers.providers.Provider,
  networkName: string
) => {
  const { etherscanApiKey, etherscanApiEndpoints } = await getEtherscanInfo(
    provider,
    networkName
  )

  const canonicalConfig = await callWithTimeout<CanonicalChugSplashConfig>(
    chugsplashFetchSubtask({ configUri }),
    30000,
    'Failed to fetch config file from IPFS'
  )
  const artifacts = await getCanonicalConfigArtifacts(canonicalConfig)
  // Link the project's ChugSplashManagerProxy with the ChugSplashManager.
  const chugsplashManagerProxyAddress = getChugSplashManagerProxyAddress(
    canonicalConfig.options.projectName
  )
  try {
    await linkProxyWithImplementation(
      etherscanApiEndpoints,
      etherscanApiKey,
      chugsplashManagerProxyAddress,
      INITIAL_CHUGSPLASH_MANAGER_ADDRESS,
      'ChugSplashManager'
    )
  } catch (err) {
    console.error(err)
  }

  for (const [referenceName, contractConfig] of Object.entries(
    canonicalConfig.contracts
  )) {
    const artifact = artifacts[referenceName]
    const { abi, contractName, sourceName, creationCodeWithConstructorArgs } =
      artifact
    const { constructorArgValues } = getConstructorArgs(
      canonicalConfig.contracts[referenceName].constructorArgs,
      referenceName,
      abi
    )
    const implementationAddress = getImplAddress(
      canonicalConfig.options.projectName,
      referenceName,
      creationCodeWithConstructorArgs
    )

    const { input, solcVersion } = canonicalConfig.inputs.find(
      (compilerInput) =>
        Object.keys(compilerInput.input.sources).includes(sourceName)
    )

    const minimumCompilerInput = getMinimumCompilerInput(
      input,
      artifact.compilerOutput.contracts,
      sourceName,
      contractName
    )

    try {
      // Verify the implementation
      await attemptVerification(
        provider,
        networkName,
        etherscanApiEndpoints,
        implementationAddress,
        sourceName,
        contractName,
        abi,
        etherscanApiKey,
        minimumCompilerInput,
        solcVersion,
        constructorArgValues
      )

      // Link the proxy with its implementation
      await linkProxyWithImplementation(
        etherscanApiEndpoints,
        etherscanApiKey,
        contractConfig.proxy,
        implementationAddress,
        contractName
      )
    } catch (err) {
      console.error(err)
    }
  }
}

export const verifyChugSplash = async (
  provider: ethers.providers.Provider,
  networkName: string
) => {
  const { etherscanApiKey, etherscanApiEndpoints } = await getEtherscanInfo(
    provider,
    networkName
  )

  const contracts = [
    {
      artifact: ChugSplashManagerArtifact,
      address: INITIAL_CHUGSPLASH_MANAGER_ADDRESS,
    },
    {
      artifact: ChugSplashBootLoaderArtifact,
      address: CHUGSPLASH_BOOTLOADER_ADDRESS,
    },
    { artifact: DefaultUpdaterArtifact, address: DEFAULT_UPDATER_ADDRESS },
    { artifact: DefaultAdapterArtifact, address: DEFAULT_ADAPTER_ADDRESS },
    {
      artifact: OZTransparentAdapterArtifact,
      address: OZ_TRANSPARENT_ADAPTER_ADDRESS,
    },
    { artifact: OZUUPSUpdaterArtifact, address: OZ_UUPS_UPDATER_ADDRESS },
    { artifact: OZUUPSAdapterArtifact, address: OZ_UUPS_ADAPTER_ADDRESS },
    {
      artifact: ChugSplashRegistryProxyArtifact,
      address: CHUGSPLASH_REGISTRY_PROXY_ADDRESS,
    },
    {
      artifact: ChugSplashManagerProxyArtifact,
      address: ROOT_CHUGSPLASH_MANAGER_PROXY_ADDRESS,
    },
    {
      artifact: ChugSplashRegistryArtifact,
      address: CHUGSPLASH_REGISTRY_ADDRESS,
    },
    { artifact: DefaultAdapterArtifact, address: DEFAULT_ADAPTER_ADDRESS },
    {
      artifact: ProxyInitializerArtifact,
      address: PROXY_INITIALIZER_ADDRESS,
    },
  ]

  for (const { artifact, address } of contracts) {
    const { sourceName, contractName, abi } = artifact

    const minimumCompilerInput = getMinimumCompilerInput(
      buildInfo.input,
      buildInfo.output.contracts,
      sourceName,
      contractName
    )

    await attemptVerification(
      provider,
      networkName,
      etherscanApiEndpoints,
      address,
      sourceName,
      contractName,
      abi,
      etherscanApiKey,
      minimumCompilerInput,
      buildInfo.solcVersion,
      CHUGSPLASH_CONSTRUCTOR_ARGS[sourceName]
    )
  }

  // Link the ChugSplashRegistry's implementation with its proxy
  await linkProxyWithImplementation(
    etherscanApiEndpoints,
    etherscanApiKey,
    CHUGSPLASH_REGISTRY_PROXY_ADDRESS,
    CHUGSPLASH_REGISTRY_ADDRESS,
    'ChugSplashRegistry'
  )

  // Link the root ChugSplashManager's implementation with its proxy
  await linkProxyWithImplementation(
    etherscanApiEndpoints,
    etherscanApiKey,
    ROOT_CHUGSPLASH_MANAGER_PROXY_ADDRESS,
    INITIAL_CHUGSPLASH_MANAGER_ADDRESS,
    'ChugSplashManager'
  )
}

export const attemptVerification = async (
  provider: ethers.providers.Provider,
  networkName: string,
  etherscanApiEndpoints: EtherscanURLs,
  contractAddress: string,
  sourceName: string,
  contractName: string,
  abi: any,
  etherscanApiKey: string,
  compilerInput: CompilerInput,
  solcVersion: string,
  constructorArgValues: any[]
): Promise<EtherscanResponse> => {
  const deployedBytecodeHex = await retrieveContractBytecode(
    contractAddress,
    // Todo - figure out how to fit JsonRpcProvider into EthereumProvider type without casting as any
    provider as any,
    networkName
  )
  const deployedBytecode = new Bytecode(deployedBytecodeHex)
  const inferredSolcVersion = deployedBytecode.getInferredSolcVersion()

  assert(
    solcVersion === inferredSolcVersion,
    'Compiler version in artifact does not match deployed contract compiler version'
  )

  const solcFullVersion = await getLongVersion(solcVersion)

  // TODO: We can replace this by ABI-encoding the result of our `getConstructorArgs` function.
  const constructorArgsAbiEncoded = await encodeArguments(
    abi,
    sourceName,
    contractName,
    constructorArgValues
  )

  const verifyRequest = toVerifyRequest({
    apiKey: etherscanApiKey,
    contractAddress,
    sourceCode: JSON.stringify(compilerInput),
    sourceName,
    contractName,
    compilerVersion: solcFullVersion,
    constructorArguments: constructorArgsAbiEncoded,
  })
  let response
  try {
    response = await verifyContract(etherscanApiEndpoints.apiURL, verifyRequest)
  } catch (err) {
    if (err.message === 'Contract source code already verified') {
      console.log(
        `${contractName} has already been already verified:
        ${buildContractUrl(etherscanApiEndpoints.browserURL, contractAddress)}`
      )
      return
    } else {
      throw err
    }
  }

  console.log(
    `Successfully submitted source code for contract
     ${sourceName}:${contractName} at ${contractAddress}
     for verification on the block explorer. Waiting for verification result...
    `
  )

  const pollRequest = toCheckStatusRequest({
    apiKey: etherscanApiKey,
    guid: response.message,
  })

  // Compilation is bound to take some time so there's no sense in requesting status immediately.
  await delay(700)
  let verificationStatus
  try {
    verificationStatus = await getVerificationStatus(
      etherscanApiEndpoints.apiURL,
      pollRequest
    )
  } catch (err) {
    if (err.message.includes('Reason: Already Verified')) {
      console.log(
        `${contractName} has already been already verified:
        ${buildContractUrl(etherscanApiEndpoints.browserURL, contractAddress)}`
      )
      return
    } else {
      throw err
    }
  }

  if (verificationStatus.isVerificationSuccess()) {
    const contractURL = buildContractUrl(
      etherscanApiEndpoints.browserURL,
      contractAddress
    )
    console.log(
      `Successfully verified ${contractName} on Etherscan:
      ${contractURL}`
    )
  } else {
    // Reaching this point shouldn't be possible unless the API is behaving in a new way.
    throw new Error(
      `The Etherscan API responded with an unexpected message.
      Contract verification may have succeeded and should be checked manually.
      Message: ${verificationStatus.message}`
    )
  }
}

export const getEtherscanInfo = async (
  provider: ethers.providers.Provider,
  networkName: string
): Promise<{
  etherscanApiKey: string
  etherscanApiEndpoints: EtherscanURLs
}> => {
  const { urls: etherscanApiEndpoints } = await getEtherscanEndpoints(
    // Todo - figure out how to fit JsonRpcProvider into EthereumProvider type without casting as any
    provider as any,
    networkName,
    chainConfig,
    customChains
  )

  return { etherscanApiKey: apiKey, etherscanApiEndpoints }
}

export const linkProxyWithImplementation = async (
  etherscanApiEndpoints: EtherscanURLs,
  etherscanApiKey: string,
  proxyAddress: string,
  implAddress: string,
  implContractName: string
) => {
  const params = {
    module: 'contract',
    action: 'verifyproxycontract',
    address: proxyAddress,
    expectedimplementation: implAddress,
  }
  let responseBody = await callEtherscanApi(
    etherscanApiEndpoints,
    etherscanApiKey,
    params
  )

  if (responseBody.status === RESPONSE_OK) {
    // Initial call was OK, but need to send a status request using the returned guid to get the
    // actual verification status
    const guid = responseBody.result
    responseBody = await checkProxyVerificationStatus(
      etherscanApiEndpoints,
      etherscanApiKey,
      guid
    )

    while (responseBody.result === 'Pending in queue') {
      await delay(3000)
      responseBody = await checkProxyVerificationStatus(
        etherscanApiEndpoints,
        etherscanApiKey,
        guid
      )
    }
  }

  if (responseBody.status === RESPONSE_OK) {
    console.log(
      `Successfully linked ${implContractName} proxy to implementation.`
    )
  } else {
    throw new Error(
      `Failed to link ${implContractName} proxy with its implementation.
Reason: ${responseBody.result}`
    )
  }
}

export const callEtherscanApi = async (
  etherscanApiEndpoints: EtherscanURLs,
  etherscanApiKey: string,
  params: any
): Promise<EtherscanResponseBody> => {
  const parameters = new URLSearchParams({
    ...params,
    apikey: etherscanApiKey,
  })

  const response = await request(etherscanApiEndpoints.apiURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: parameters.toString(),
  })

  if (!(response.statusCode >= 200 && response.statusCode <= 299)) {
    const responseBodyText = await response.body.text()
    throw new Error(
      `Etherscan API call failed with status ${response.statusCode}.
Response: ${responseBodyText}`
    )
  }

  const responseBodyJson = await response.body.json()
  return responseBodyJson
}

export const checkProxyVerificationStatus = async (
  etherscanApiEndpoints: EtherscanURLs,
  etherscanApiKey: string,
  guid: string
): Promise<EtherscanResponseBody> => {
  const checkProxyVerificationParams = {
    module: 'contract',
    action: 'checkproxyverification',
    apikey: etherscanApiKey,
    guid,
  }

  const responseBody = await callEtherscanApi(
    etherscanApiEndpoints,
    etherscanApiKey,
    checkProxyVerificationParams
  )
  return responseBody
}

export const isSupportedNetworkOnEtherscan = (chainId: number): boolean => {
  const chainIds = Object.values(chainConfig).map((config) => config.chainId)
  const customChainIds = customChains.map((chain) => chain.chainId)
  return chainIds.includes(chainId) || customChainIds.includes(chainId)
}
