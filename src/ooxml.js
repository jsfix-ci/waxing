import OleCompoundDoc from './oleFile'
import struct from 'python-struct'
import xmldom from 'xmldom'
import * as ECMA376Agile from './ecma376_agile.js'
import WaxingError from './errors'

const _ECD_COMMENT_SIZE = 7

const structEndArchive = '<4s4H2LH'
const stringEndArchive = 'PK\u0005\u0006'

// magic bytes that should be at the beginning of every OLE file:
const MAGIC_BYTES = '\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1'

export const decryptOfficeFile = async (buffer, getPasswordCallback) => {
  try {
    const doc = new OleCompoundDoc(buffer)
    const headerBuffer = await OLEStreamToBuffer(doc, 'EncryptionInfo')
    const encryptionType = parseEncryptionType(headerBuffer)
    if (encryptionType !== 'agile') throw new WaxingError(WaxingError.UNSUPPORTED_ENCRYPTION_INFO)
    const inputBuffer = await OLEStreamToBuffer(doc, 'EncryptedPackage')
    const info = parseInfoAgile(headerBuffer)
    const password = await getPasswordCallback()
    const outputBuffer = await decrypt(inputBuffer, password, info)
    if (!isZipFile(outputBuffer)) throw new WaxingError(WaxingError.INVALID_DECRYPTED_FILE)
    return outputBuffer
  } catch (error) {
    if (error.message === 'Not a valid compound document.' || error.message === 'Invalid Short Sector Allocation Table') throw new WaxingError(WaxingError.INVALID_COMPOUND_FILE)
    else throw error
  }
}

export const isOLEDoc = (buffer) => {
  const magicBuffer = Buffer.from(MAGIC_BYTES, 'binary')
  return buffer.slice(0, magicBuffer.length).equals(magicBuffer)
}

export const isZipFile = (buffer) => {
  const fileSize = buffer.byteLength
  const sizeEndCentDir = struct.sizeOf(structEndArchive)
  const newBuffer = buffer.slice(fileSize - sizeEndCentDir, fileSize)
  if (newBuffer.length === sizeEndCentDir &&
    newBuffer.slice(0, 4).toString('base64') === Buffer.from(stringEndArchive).toString('base64') &&
    newBuffer.slice(newBuffer.length - 2, newBuffer.length).toString('base64') === Buffer.from('\u0000\u0000').toString('base64')) {
    const endrec = struct.unpack(structEndArchive, newBuffer)
    endrec.push(Buffer.from(''))
    endrec.push(fileSize - sizeEndCentDir)
    return true
  }
  const maxCommentStart = Math.max(fileSize - 65536 - sizeEndCentDir, 0)
  const newBufferBis = newBuffer.slice(0, maxCommentStart)
  const start = newBufferBis.toString('utf8').lastIndexOf(stringEndArchive.toString('utf8'))
  if (start >= 0) {
    const raceData = newBufferBis.slice(start, start + sizeEndCentDir)
    if (raceData.length !== sizeEndCentDir) return false
    const _endrec = struct.unpack(structEndArchive, raceData)
    const commentSize = _endrec[_ECD_COMMENT_SIZE]
    const comment = newBufferBis.slice(start + sizeEndCentDir, start + sizeEndCentDir + commentSize)
    _endrec.push(comment)
    _endrec.push(maxCommentStart + start)
    return true
  }
  return false
}

const OLEStreamToBuffer = (doc, streamName) => {
  const chunks = []
  return new Promise((resolve, reject) => {
    const stream = doc.stream(streamName)
    stream.on('data', (chunk) => {
      chunks.push(chunk)
    })
    stream.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    stream.on('error', (error) => reject(error))
  })
}

const parseEncryptionType = (buffer) => {
  const versionMajor = struct.unpack('<HH', buffer.slice(0, 4))[0]
  const versionMinor = struct.unpack('<HH', buffer.slice(0, 4))[1]
  if (versionMajor === 4 && versionMinor === 4) return 'agile'
  else return 'unsupported'
}

const parseInfoAgile = (buffer) => {
  const stringBuffer = buffer.toString('utf8')
  const Parser = xmldom.DOMParser
  const xml = new Parser().parseFromString(stringBuffer, 'text/xml')
  const keyDataSalt = Buffer.from(xml.getElementsByTagName('keyData')[0].getAttribute('saltValue'), 'base64').toString('binary')
  const keyDataHashAlgorithm = xml.getElementsByTagName('keyData')[0].getAttribute('hashAlgorithm')
  const passwordNode = xml.getElementsByTagNameNS('http://schemas.microsoft.com/office/2006/keyEncryptor/password', 'encryptedKey')[0]
  const spinValue = parseInt(passwordNode.getAttribute('spinCount'))
  const encryptedKeyValue = Buffer.from(passwordNode.getAttribute('encryptedKeyValue'), 'base64').toString('binary')
  const encryptedVerifierHashInput = Buffer.from(passwordNode.getAttribute('encryptedVerifierHashInput'), 'base64').toString('binary')
  const encryptedVerifierHashValue = Buffer.from(passwordNode.getAttribute('encryptedVerifierHashValue'), 'base64').toString('binary')
  const passwordSalt = Buffer.from(passwordNode.getAttribute('saltValue'), 'base64').toString('binary')
  const passwordHashAlgorithm = passwordNode.getAttribute('hashAlgorithm')
  const passwordKeyBits = parseInt(passwordNode.getAttribute('keyBits'))
  return {
    keyDataSalt,
    keyDataHashAlgorithm,
    spinValue,
    encryptedKeyValue,
    passwordSalt,
    passwordHashAlgorithm,
    passwordKeyBits,
    encryptedVerifierHashInput,
    encryptedVerifierHashValue
  }
}

const loadKey = (password, info) =>
  ECMA376Agile.makeKeyFromPassword(
    password,
    info.passwordSalt,
    info.passwordHashAlgorithm,
    info.encryptedKeyValue,
    info.spinValue,
    info.passwordKeyBits
  )

const decrypt = async (buffer, password, info) => ECMA376Agile.decrypt(loadKey(password, info), info.keyDataSalt, info.keyDataHashAlgorithm, buffer)
