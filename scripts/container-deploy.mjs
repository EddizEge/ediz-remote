import {
  ContainerSecurityAuditError,
  runContainerDeployment,
} from './container-security-audit.mjs'

if (process.argv.length !== 2) {
  console.error('container_deployment_failed:configuration_invalid')
  process.exitCode = 1
} else {
  try {
    runContainerDeployment()
  } catch (error) {
    const code = error instanceof ContainerSecurityAuditError
      ? error.code
      : 'internal_error'
    console.error(`container_deployment_failed:${code}`)
    process.exitCode = 1
  }
}
