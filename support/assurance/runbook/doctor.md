#  **Spry for DevOps / SRE**

Spry allows DevOps and SRE teams to define, document, and automate operational
workflows in **executable Markdown**. Instead of using scattered scripts, tribal
knowledge, or outdated runbooks, Spry unifies:

- Documentation
- Automation scripts
- Monitoring & health checks
- Incident response runbooks
- Infrastructure provisioning logic

All in **version-controlled Markdown**.



#  What is Spry for DevOps / SRE?

Spry for DevOps/SRE enables teams to:

- Codify infrastructure automation
- Build self-documenting runbooks
- Execute health checks and recovery tasks
- Standardize deployments, scaling, and incident workflows
- Reduce human error through repeatable automated tasks

Every runbook becomes a **reliable automation unit**, stored next to your source
code.



#  Why DevOps / SRE Teams Use Spry

###  **Unified documentation + execution**

One source of truth for docs + automation.

###  **Version-controlled processes**

Operational changes are tracked in Git — enabling audit, rollback, and review.

###  **Reproducible reliability workflows**

Same behavior across Dev / Staging / Production.

###  **Better onboarding**

New engineers learn by reading + running the same executable docs.

---

#  Getting Started

### **Prerequisites**

- Spry CLI installed [https://sprymd.org/docs/getting-started/installation/]

### **Initialize project**

You may:

- Use an existing Spry repository, or
- Create a new SRE/Infra automation module



#  **Linux Monitoring Runbooks — Core Tasks**

These tasks are **simple, critical, and ideal for demos**, onboarding, and real
SRE/DevOps usage.

They include checks for:

- CPU
- Memory
- Disk
- SSH security
- Critical services



#  **CPU Utilization Monitoring**

### **Purpose:**

Detect CPU overload conditions and notify when CPU usage exceeds 80%.


##  Example Spry Task

```bash cpu-utilization -C CPUusage --descr "Check CPU utilization using osquery and notify if threshold crossed"
#!/usr/bin/env -S bash

THRESHOLD=80
EMAIL="devops-team@example.com"
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")


CPU_USAGE=$(osqueryi --json "
  SELECT 
    ROUND(AVG(100.0 - (idle * 100.0 / (user + system + idle + nice))), 2)
    AS avg_cpu_usage_percent 
  FROM cpu_time;
" | jq -r '.[0].avg_cpu_usage_percent')

CPU_INT=$(printf "%.0f" "$CPU_USAGE")

echo "$TIMESTAMP Current CPU Usage: ${CPU_INT}%"

if [ "$CPU_INT" -gt "$THRESHOLD" ]; then
    SUBJECT="ALERT: High CPU Usage on $(hostname)"
    BODY="CPU usage is ${CPU_INT}% (Threshold: ${THRESHOLD}%)."
    echo "$BODY" | mail -s "$SUBJECT" "$EMAIL"
    exit 1
fi

echo " $TIMESTAMP CPU usage normal"
```

#  **Disk Usage Monitoring**

Alerts when the root filesystem exceeds 80% usage.

```bash check-disk -C Diskusage --descr "Check root disk usage"
#!/usr/bin/env -S bash

THRESHOLD=80
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

USAGE=$(df -h / | awk 'NR==2 {gsub("%","",$5); print $5}')

echo "$TIMESTAMP Disk Usage: ${USAGE}%"

if [ "$USAGE" -gt "$THRESHOLD" ]; then
  echo " ALERT: Disk usage exceeded ${THRESHOLD}%"
  exit 1
fi

echo " $TIMESTAMP Disk usage normal"
```

#  **Memory Usage Monitoring**

Monitors RAM utilization and triggers alert if crossing 80%.

```bash check-memory -C Memoryusage --descr "Check memory usage percentage"
#!/usr/bin/env -S bash

THRESHOLD=80
USED=$(free | awk '/Mem:/ {printf("%d"), ($3/$2)*100}')

echo "Memory Usage: ${USED}%"

if [ "$USED" -gt "$THRESHOLD" ]; then
  echo " ALERT: High memory usage"
  exit 1
fi

echo " Memory usage normal"
```

#  **Failed SSH Login Detection**

Detects brute-force attempts and abnormal SSH activity.

```bash check-ssh-fail --descr "Detect failed SSH login attempts"
#!/usr/bin/env -S bash

THRESHOLD=10
FAILS=$(grep -c "Failed password" /var/log/auth.log)

echo "Failed SSH Logins: $FAILS"

if [ "$FAILS" -gt "$THRESHOLD" ]; then
  echo " ALERT: Possible brute-force attack"
  exit 1
fi

echo " SSH login activity normal"
```

#  **Critical Service Availability Check**

Ensures critical system services (example: nginx) are running.

```bash check-Service-runnning --capture ./Service-status.txt --decr "Check if Critical Service is Running"
#!/usr/bin/env -S bash

SERVICE="nginx"
EMAIL="devops-team@example.com"

IS_RUNNING=$(osqueryi --json "
SELECT count(*) AS running
FROM processes
WHERE name = 'nginx'
AND cmdline LIKE '%master process%';
" | jq -r '.[0].running')

echo "Master process count: $IS_RUNNING"

if [ "$IS_RUNNING" -eq 0 ]; then
    SUBJECT="ALERT: Service $SERVICE Not Running"
    BODY="Critical service '$SERVICE' is NOT running on $(hostname)."

    echo "$BODY" | mail -s "$SUBJECT" "$EMAIL"
    echo "Alert email sent!"
else
    echo "$SERVICE is running."
fi
```

Here It helps to show the output of each task

```bash Compilation-Results -I --descr "Show captured output"
#!/usr/bin/env -S cat
# from cpu captured output: "${captured.CPUusage.text().trim()}"
# from disk captured output: "${captured.Diskusage.text().trim()}"
# from memory captured output: "${captured.Memoryusage.text().trim()}"
```
