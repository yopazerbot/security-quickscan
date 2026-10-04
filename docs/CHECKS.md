# Check catalogue

Security QuickScan runs **84 read-only checks**. Each check maps to one primary ISO/IEC 27001:2022 Annex A control (bold) and optional secondary controls.
Every scan runs every check for the platforms in scope. Findings that do not apply can be marked not applicable afterwards, which leaves them out of the score.

_This file is generated from `packages/shared/src/catalog` by `npm run docs:checks`._

## Microsoft 365 / Entra ID (23)

| Check | Severity | Domain | ISO 27001:2022 | Other refs |
| --- | --- | --- | --- | --- |
| MFA enforced for all users | critical | Identity & Access | **A.8.5**, A.5.17 | M365 CIS v4.0 5.2.2.2; NIS2 Art. 21(2)(j) |
| Legacy authentication blocked | high | Identity & Access | **A.8.5** | M365 CIS v4.0 5.2.2.3 |
| Phishing-resistant MFA for administrators | high | Privileged Access | **A.8.5**, A.8.2 | M365 CIS v4.0 5.2.2.1, 5.2.2.5 |
| Between 2 and 4 Global Administrators | high | Privileged Access | **A.8.2**, A.5.18 | M365 CIS v4.0 1.1.3 |
| Privileged accounts are cloud-only | medium | Privileged Access | **A.8.2** | M365 CIS v4.0 1.1.1 |
| Users registered for MFA | high | Identity & Access | **A.8.5**, A.5.17 | M365 CIS v4.0 5.2.3.4 |
| User consent to applications restricted | medium | Governance & Hygiene | **A.5.15**, A.8.2, A.5.23 | M365 CIS v4.0 5.1.5.1 |
| Users cannot register applications | low | Governance & Hygiene | **A.5.15**, A.8.9 | M365 CIS v4.0 5.1.2.2 |
| Guest invitations restricted | medium | Identity & Access | **A.5.15** | M365 CIS v4.0 5.1.6.3 |
| Guest directory access restricted | low | Identity & Access | **A.8.3** | M365 CIS v4.0 5.1.6.2 |
| No stale enabled accounts (90+ days) | medium | Identity & Access | **A.5.18**, A.5.16 |  |
| No over-privileged application permissions | high | Privileged Access | **A.8.2**, A.5.19 |  |
| Privileged Identity Management in use | medium | Privileged Access | **A.8.2** | M365 CIS v4.0 5.3.1 |
| Sign-in and user risk policies | medium | Identity & Access | **A.8.5**, A.8.16 | M365 CIS v4.0 5.2.2.6, 5.2.2.7 |
| Access requires managed or compliant devices | medium | Identity & Access | **A.8.1**, A.6.7 |  |
| Weak MFA methods (SMS / voice) disabled | low | Identity & Access | **A.8.5** | M365 CIS v4.0 5.2.3.5 |
| SPF, DKIM and DMARC enforced on mail domains | medium | Network Exposure | **A.5.14**, A.8.21 | M365 CIS v4.0 2.1.8, 2.1.9, 2.1.10 |
| Microsoft Secure Score | low | Governance & Hygiene | **A.8.9** |  |
| Device code flow blocked | high | Identity & Access | **A.8.5** | M365 CIS v4.0 5.2.2.12 |
| Session controls for administrators | medium | Privileged Access | **A.8.5**, A.8.2 | M365 CIS v4.0 5.2.2.4 |
| Authenticator number matching and context | medium | Identity & Access | **A.8.5** | M365 CIS v4.0 5.2.3.1 |
| No long-lived application secrets | high | Privileged Access | **A.5.17**, A.8.2 |  |
| No guests or service principals in privileged roles | high | Privileged Access | **A.8.2**, A.5.18 |  |

## Microsoft Azure (13)

| Check | Severity | Domain | ISO 27001:2022 | Other refs |
| --- | --- | --- | --- | --- |
| Microsoft Defender for Cloud plans enabled | high | Logging & Detection | **A.8.16** | Azure CIS v3.0 2.1.1-2.1.13 |
| Security contact configured | low | Logging & Detection | **A.5.24**, A.5.25 | Azure CIS v3.0 2.1.19, 2.1.20 |
| Activity log exported | medium | Logging & Detection | **A.8.15** | Azure CIS v3.0 5.1.1, 5.1.2 |
| Storage accounts disallow public blob access | high | Data Protection | **A.8.3** | Azure CIS v3.0 3.17 |
| Storage enforces HTTPS and TLS 1.2+ | medium | Data Protection | **A.8.24** | Azure CIS v3.0 3.1, 3.15 |
| Storage network access restricted | high | Network Exposure | **A.8.20**, A.8.3 | Azure CIS v3.0 3.7, 3.8, 3.11 |
| Key Vault soft delete, purge protection and RBAC | medium | Data Protection | **A.8.24** | Azure CIS v3.0 8.5, 8.6 |
| No management or database ports open to the internet | high | Network Exposure | **A.8.20** | Azure CIS v3.0 6.1, 6.2 |
| SQL servers not open to the internet | high | Network Exposure | **A.8.20**, A.8.3 | Azure CIS v3.0 4.1.2 |
| SQL auditing, TDE and Entra admin | high | Logging & Detection | **A.8.15**, A.8.24 | Azure CIS v3.0 4.1.1, 4.1.4, 4.1.5 |
| No unhealthy high-severity Defender recommendations | high | Governance & Hygiene | **A.8.8**, A.8.9 |  |
| Backup vaults protected against deletion | medium | Data Protection | **A.8.13** |  |
| Limited subscription Owners | medium | Privileged Access | **A.8.2**, A.5.18 |  |

## Amazon Web Services (28)

| Check | Severity | Domain | ISO 27001:2022 | Other refs |
| --- | --- | --- | --- | --- |
| Root account protected with MFA | critical | Privileged Access | **A.8.5**, A.8.2 | AWS CIS 1.5, 1.6, 1.7; NIS2 Art. 21(2)(j) |
| No access keys for the root account | critical | Privileged Access | **A.8.2**, A.5.17 | AWS CIS 1.4 |
| Console IAM users have MFA | high | Identity & Access | **A.8.5**, A.5.17 | AWS CIS 1.10; NIS2 Art. 21(2)(j) |
| Access keys rotated within 90 days | medium | Identity & Access | **A.5.17** | AWS CIS 1.14 |
| No unused credentials (45+ days) | medium | Identity & Access | **A.5.18**, A.5.16 | AWS CIS 1.12 |
| Strong IAM password policy | low | Identity & Access | **A.5.17** | AWS CIS 1.8, 1.9 |
| No IAM users with administrator access | high | Privileged Access | **A.8.2**, A.5.15 | AWS CIS 1.16 |
| Multi-region CloudTrail with log validation | high | Logging & Detection | **A.8.15** | AWS CIS 3.1, 3.2, 3.5; NIS2 Art. 21(2)(b) |
| GuardDuty threat detection enabled | high | Logging & Detection | **A.8.16** | NIS2 Art. 21(2)(b) |
| Security Hub enabled | medium | Logging & Detection | **A.8.16**, A.8.9 | AWS CIS 4.16 |
| AWS Config recording enabled | medium | Governance & Hygiene | **A.8.9** | AWS CIS 3.3 |
| Account-level S3 Block Public Access | high | Data Protection | **A.8.3** | AWS CIS 2.1.4 |
| No publicly accessible S3 buckets | critical | Data Protection | **A.8.3** | AWS CIS 2.1.4 |
| EBS encryption by default | medium | Data Protection | **A.8.24** | AWS CIS 2.2.1 |
| No admin ports open to the internet | high | Network Exposure | **A.8.20** | AWS CIS 5.2, 5.3; NIS2 Art. 21(2)(e) |
| EC2 instances require IMDSv2 | medium | Governance & Hygiene | **A.8.9** | AWS CIS 5.6 |
| No publicly accessible RDS instances | high | Network Exposure | **A.8.20**, A.8.3 | AWS CIS 2.3.3 |
| RDS storage encrypted | medium | Data Protection | **A.8.24** | AWS CIS 2.3.1 |
| RDS automated backups retained 7+ days | medium | Data Protection | **A.8.13** | NIS2 Art. 21(2)(c) |
| Customer managed KMS keys rotated | low | Data Protection | **A.8.24** | AWS CIS 3.6 |
| IAM Access Analyzer enabled | low | Governance & Hygiene | **A.5.18**, A.5.19 | AWS CIS 1.20 |
| Default security groups restrict all traffic | medium | Network Exposure | **A.8.20** | AWS CIS 5.4 |
| VPC flow logs enabled | medium | Logging & Detection | **A.8.15**, A.8.16 | AWS CIS 3.7; NIS2 Art. 21(2)(b) |
| No public snapshots or AMIs | high | Data Protection | **A.8.3**, A.8.12 |  |
| S3 buckets deny plain HTTP | medium | Data Protection | **A.8.24** | AWS CIS 2.1.1; NIS2 Art. 21(2)(h) |
| No open critical or high Security Hub findings | high | Logging & Detection | **A.8.8**, A.8.9 | NIS2 Art. 21(2)(e) |
| AWS Backup plans protect resources | medium | Data Protection | **A.8.13** | NIS2 Art. 21(2)(c) |
| Amazon Inspector vulnerability scanning | medium | Governance & Hygiene | **A.8.8** | NIS2 Art. 21(2)(e) |

## GitHub (20)

| Check | Severity | Domain | ISO 27001:2022 | Other refs |
| --- | --- | --- | --- | --- |
| Organisation requires 2FA | critical | Identity & Access | **A.8.5**, A.8.4 | GitHub CIS 1.3.5; NIS2 Art. 21(2)(j) |
| Least-privilege base permissions | high | Identity & Access | **A.8.4**, A.5.15 | GitHub CIS 1.3.8 |
| Limited organisation owners | medium | Privileged Access | **A.8.2** | GitHub CIS 1.3.3 |
| Outside collaborators reviewed | medium | Identity & Access | **A.5.19**, A.5.18 |  |
| Members cannot create public repositories | medium | Data Protection | **A.8.12**, A.8.4 | GitHub CIS 1.2.2 |
| Private repository forking restricted | low | Data Protection | **A.8.12** |  |
| Public repositories reviewed | info | Data Protection | **A.8.12** |  |
| Default branches protected | high | Code & Supply Chain | **A.8.32**, A.8.25, A.8.4 | GitHub CIS 1.1.3, 1.1.4, 1.1.14, 1.1.16, 1.1.17 |
| Secret scanning enabled | high | Code & Supply Chain | **A.8.28**, A.5.17 | GitHub CIS 1.5.1 |
| Secret push protection enabled | medium | Code & Supply Chain | **A.8.28**, A.5.17 | GitHub CIS 1.5.1 |
| No open secret scanning alerts | critical | Code & Supply Chain | **A.8.28**, A.5.17 | GitHub CIS 1.5.1 |
| No open critical/high Dependabot alerts | high | Code & Supply Chain | **A.8.8**, A.5.21, A.8.25 | GitHub CIS 1.5.5; NIS2 Art. 21(2)(e) |
| No open critical/high code scanning alerts | medium | Code & Supply Chain | **A.8.28**, A.8.8 | GitHub CIS 1.5.4 |
| GitHub Actions restricted to trusted actions | medium | Code & Supply Chain | **A.5.21**, A.8.25 |  |
| Read-only default workflow token | high | Code & Supply Chain | **A.8.25**, A.8.2 |  |
| Deploy keys are read-only | low | Code & Supply Chain | **A.5.17**, A.8.4 |  |
| Webhooks use verified HTTPS | low | Network Exposure | **A.8.21**, A.8.24 |  |
| No members without 2FA | high | Identity & Access | **A.8.5** | GitHub CIS 1.3.4; NIS2 Art. 21(2)(j) |
| GitHub Apps hold least privilege | medium | Code & Supply Chain | **A.5.21**, A.5.19 | GitHub CIS 1.4.3 |
| Security features on by default for new repositories | low | Code & Supply Chain | **A.8.9**, A.8.25 |  |

## Annex A coverage

| Control | Title | Primary checks | Secondary checks |
| --- | --- | --- | --- |
| A.5.14 | Information transfer | 1 | 0 |
| A.5.15 | Access control | 3 | 2 |
| A.5.16 | Identity management | 0 | 2 |
| A.5.17 | Authentication information | 4 | 7 |
| A.5.18 | Access rights | 3 | 4 |
| A.5.19 | Information security in supplier relationships | 1 | 3 |
| A.5.21 | Managing information security in the ICT supply chain | 2 | 1 |
| A.5.23 | Information security for use of cloud services | 0 | 1 |
| A.5.24 | Incident management planning and preparation | 1 | 0 |
| A.5.25 | Assessment and decision on information security events | 0 | 1 |
| A.6.7 | Remote working | 0 | 1 |
| A.8.1 | User endpoint devices | 1 | 0 |
| A.8.2 | Privileged access rights | 9 | 6 |
| A.8.3 | Information access restriction | 5 | 3 |
| A.8.4 | Access to source code | 1 | 4 |
| A.8.5 | Secure authentication | 13 | 0 |
| A.8.8 | Management of technical vulnerabilities | 4 | 1 |
| A.8.9 | Configuration management | 4 | 4 |
| A.8.12 | Data leakage prevention | 3 | 1 |
| A.8.13 | Information backup | 3 | 0 |
| A.8.15 | Logging | 4 | 0 |
| A.8.16 | Monitoring activities | 3 | 2 |
| A.8.20 | Networks security | 6 | 0 |
| A.8.21 | Security of network services | 1 | 1 |
| A.8.24 | Use of cryptography | 6 | 2 |
| A.8.25 | Secure development life cycle | 1 | 4 |
| A.8.28 | Secure coding | 4 | 0 |
| A.8.32 | Change management | 1 | 0 |
