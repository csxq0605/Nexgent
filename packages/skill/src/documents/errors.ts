/** A document that cannot be read (corrupt, encrypted, unsupported); `read_document` turns it into a tool error. */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentError'
  }
}
