/** Live validation of the pure-fetch Kaggle REST client (write + read paths).
 * Usage: KAGGLE_API_TOKEN=KGAT_... bun scripts/test-rest-client.ts */
process.env.KAGGLE_API_TOKEN ||= ''

async function main() {
  const k = await import('../src/lib/kaggle')

  console.log('1) kernelStatus(worker-test):', await k.kernelStatus(k.WORKER_TEST_KERNEL))

  console.log('2) datasetPushVersion(rmc-studio-outputs) — blob upload + create version...')
  const t0 = Date.now()
  const res = await k.datasetPushVersion(
    k.OUTPUTS_DATASET,
    [{ name: 'rest-client-check.txt', data: Buffer.from(`REST write test ${new Date().toISOString()}\n`), contentType: 'text/plain' }],
    'vercel rest client validation',
  )
  console.log('   ->', res, `(${Date.now() - t0}ms)`)

  console.log('3) datasetLatestFileTime:', await k.datasetLatestFileTime(k.OUTPUTS_DATASET))
  console.log('4) datasetStatus:', await k.datasetStatus(k.OUTPUTS_DATASET))

  console.log('5) kernelOutputFiles(worker-test):')
  const { files } = await k.kernelOutputFiles(k.WORKER_TEST_KERNEL)
  console.log('   ', files.length, 'files; first:', files[0]?.fileName)

  const zip = await k.datasetDownloadZip(k.OUTPUTS_DATASET)
  console.log('6) datasetDownloadZip:', zip.byteLength, 'bytes')

  if (!res.ok) process.exit(1)
  console.log('ALL REST CHECKS PASSED')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
