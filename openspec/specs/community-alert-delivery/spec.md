# Community Alert Delivery Specification

## Purpose

Define recoverable Telegram opening alerts and privacy-safe printable notices for pilot zones.

## Requirements

### Requirement: Unique opening-alert intent

Each outage opening transition **MUST** create exactly one durable alert intent with a stable identity as part of the accepted state change. Retries and concurrent threshold crossings **MUST NOT** create another intent for that transition.

#### Scenario: Episode opens

- GIVEN an eligible quorum opens a new outage episode
- WHEN the opening transition is accepted
- THEN exactly one Telegram alert intent MUST exist for that transition

#### Scenario: Transition is replayed

- GIVEN an opening transition already has an alert intent
- WHEN processing is retried or repeated concurrently
- THEN no additional intent MUST be created

### Requirement: Decoupled report acceptance

Telegram delivery **MUST** occur after report acceptance. Provider unavailability, rejection, or timeout **MUST NOT** reject or reverse accepted reports, quorum, or episode state.

#### Scenario: Telegram is unavailable

- GIVEN an opening alert intent exists
- WHEN Telegram cannot accept the delivery
- THEN the accepted episode MUST remain valid
- AND the intent MUST remain recoverable for retry

### Requirement: Retryable dispatch

Undelivered intents **MUST** be retried without changing their stable identity. The system **MUST** record whether an intent is pending, delivered, retryable, cancelled, or failed. It **MUST NOT** claim exactly-once external delivery when provider behavior cannot guarantee it.

#### Scenario: Retry succeeds

- GIVEN a retryable intent previously failed
- WHEN a later delivery attempt succeeds
- THEN the same intent MUST be marked delivered

#### Scenario: Retries are bounded

- GIVEN an intent whose delivery has failed on every attempt
- WHEN the eighth attempt fails
- THEN the intent MUST be marked failed, logged without its content, and never claimed again

#### Scenario: Dispatch rollback

- GIVEN alert dispatch is disabled during rollback
- WHEN a dispatch cycle runs
- THEN pending and retryable intents MUST stay as they are, so re-enabling dispatch delivers them, without affecting accepted outage state

### Requirement: Alert scope and content

The pilot **MUST** dispatch Telegram opening alerts only. Refresh, restoration, and expiry transitions **MUST NOT** create outbound alerts. Alert content **MUST** identify the service and configured pilot zone, label the report as community-generated and unofficial, and exclude individual-report data.

#### Scenario: Episode refreshes or closes

- GIVEN an episode refreshes, is restored, or expires
- WHEN alert eligibility is evaluated
- THEN no Telegram alert intent MUST be created

#### Scenario: Opening alert content

- GIVEN an opening alert is prepared
- WHEN its content is inspected
- THEN it MUST contain the service, pilot zone, and unofficial-data label
- AND it MUST contain no name, device token, coordinates, or individual timestamp

### Requirement: Printable zone notice

For every enabled pilot zone, the system **MUST** provide a printable notice that explains how to report and access the community map. It **MUST** carry the unofficial-data label and **MUST NOT** embed resident or report-level data.

#### Scenario: Partner obtains a notice

- GIVEN a neighborhood partner selects an enabled pilot zone
- WHEN the printable notice is generated
- THEN it MUST be zone-specific, printable, and free of resident data

#### Scenario: Unknown zone requested

- GIVEN a requested zone is not enabled
- WHEN notice generation is attempted
- THEN the system MUST refuse to generate a pilot notice for that zone
