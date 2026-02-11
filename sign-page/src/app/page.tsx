export default function Home() {
  return (
    <div className="container">
      <div className="card">
        <h1 className="title">ZKProofport Signing Service</h1>
        <p className="description">
          This service allows you to sign messages with your wallet to authorize
          zero-knowledge proof generation. You will be redirected here from a ZKProofport
          proof request when wallet signing is required.
        </p>
        <p className="description">
          To sign a message, you need a valid signing request URL in the format:
          <code style={{ display: 'block', marginTop: '0.5rem', padding: '0.5rem', background: '#0a0a0a', borderRadius: '4px' }}>
            /s/{'<requestId>'}
          </code>
        </p>
      </div>
    </div>
  );
}
