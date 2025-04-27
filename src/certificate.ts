// CREDITS: https://github.com/vitejs/vite-plugin-basic-ssl/blob/main/src/certificate.ts

import forge from "node-forge"

import "node-forge/lib/pki"

import { CERTIFICATE_PASSWORD } from "./consts"

createCertificate()

function toPositiveHex(hexString: string) {
  let mostSignificativeHexAsInt = parseInt(hexString[0] ?? "0", 16)
  if (mostSignificativeHexAsInt < 8) {
    return hexString
  }

  mostSignificativeHexAsInt -= 8
  return mostSignificativeHexAsInt.toString() + hexString.substring(1)
}

export function createCertificate(name = "localhost", otherDomains: string[] = []) {
  const days = 30
  const keySize = 2048

  const appendDomains = otherDomains.map((item) => ({ type: 2, value: item }))

  const extensions = [
    {
      name: "keyUsage",
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true,
    },
    {
      name: "extKeyUsage",
      serverAuth: true,
      clientAuth: true,
      codeSigning: true,
      timeStamping: true,
    },
    {
      name: "subjectAltName",
      altNames: [
        {
          // type 2 is DNS
          type: 2,
          value: "localhost",
        },
        {
          type: 2,
          value: "[::1]",
        },
        {
          // type 7 is IP
          type: 7,
          ip: "127.0.0.1",
        },
        {
          type: 7,
          ip: "fe80::1",
        },
        ...appendDomains,
      ],
    },
  ]

  const attrs = [
    {
      name: "commonName",
      value: name,
    },
    {
      name: "countryName",
      value: "CH",
    },
    {
      shortName: "ST",
      value: "Lugano",
    },
    {
      name: "localityName",
      value: "Lugano",
    },
    {
      name: "organizationName",
      value: "Etherna SA",
    },
    {
      shortName: "OU",
      value: "Etherna SA",
    },
  ]

  const keyPair = forge.pki.rsa.generateKeyPair(keySize)

  const cert = forge.pki.createCertificate()

  cert.serialNumber = toPositiveHex(forge.util.bytesToHex(forge.random.getBytesSync(9)))

  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + days)

  cert.setSubject(attrs)
  cert.setIssuer(attrs)

  cert.publicKey = keyPair.publicKey

  cert.setExtensions(extensions)

  const algorithm = forge.md.sha256.create()
  cert.sign(keyPair.privateKey, algorithm)

  const privateKeyPem = forge.pki.privateKeyToPem(keyPair.privateKey)
  const certPem = forge.pki.certificateToPem(cert)
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
    keyPair.privateKey,
    [cert],
    CERTIFICATE_PASSWORD,
    { algorithm: "3des" } // optional, you can also use 'aes256', etc.
  )
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes()

  return {
    key: privateKeyPem,
    cert: certPem,
    pfx: p12Der,
  }
}
