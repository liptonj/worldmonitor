# Creating the Docker Monitoring Dashboard in Splunk

This guide walks you through creating a comprehensive monitoring dashboard for your Docker containers.

## Method 1: Import Dashboard XML (Fastest)

### Step 1: Copy the Dashboard XML

The dashboard XML file is located at:
```
/Users/jolipton/Projects/worldmonitor/services/splunk/docker_monitoring_dashboard.xml
```

### Step 2: Import into Splunk

1. **Login to Splunk Web** (http://your-splunk-host:8000)

2. **Navigate to Dashboards**
   - Click **Dashboards** in the top menu
   - Or go to **Search & Reporting** app → **Dashboards**

3. **Create from Source**
   - Click **Create New Dashboard** (top right)
   - Select **Create Dashboard** → **Edit Source**
   - Or if you see **Dashboard Studio**, click **Classic Dashboard** first

4. **Paste XML**
   - Delete any default XML in the editor
   - Copy and paste the entire contents of `docker_monitoring_dashboard.xml`
   - Click **Save**

5. **Set Permissions**
   - Click **Edit** → **Edit Permissions**
   - **Display For**: Everyone (or specific role)
   - **Write**: admin (or your role)
   - Click **Save**

6. **View Dashboard**
   - Click on the dashboard name to view
   - Use the time range picker and filters at the top

## Method 2: Create Dashboard Manually (Step-by-Step)

If you prefer to build it from scratch or customize:

### Step 1: Create New Dashboard

1. **Dashboards** → **Create New Dashboard**
2. **Title**: `World Monitor - Docker Container Dashboard`
3. **ID**: `docker_monitoring_dashboard`
4. **Permissions**: Shared in App (Everyone can read)
5. **Description**: `Real-time monitoring of Docker containers and services`
6. Click **Create Dashboard**

### Step 2: Add Time Range Picker

1. Click **Edit**
2. Click **Add Input** → **Time**
3. Configure:
   - **Token**: `time_range`
   - **Label**: Time Range
   - **Default**: Last 60 minutes
   - **Search on Change**: Yes

### Step 3: Add Service Filter

1. **Add Input** → **Dropdown**
2. Configure:
   - **Token**: `service_filter`
   - **Label**: Service
   - **Choices**:
     - `*` = All Services (default)
     - `gateway` = Gateway
     - `orchestrator` = Orchestrator
     - `worker` = Worker
     - `ais-processor` = AIS Processor
     - `ingest-telegram` = Telegram Ingest
     - `ai-engine` = AI Engine
     - `redis` = Redis
     - `watchtower` = Watchtower

### Step 4: Add Key Metrics (Row 1)

Create 4 **Single Value** visualizations:

#### Panel 1: Total Events
```spl
index=docker_logs service="$service_filter$" 
| eval log_level=if(match(_raw, "ERROR"), "ERROR", if(match(_raw, "WARN"), "WARN", if(match(_raw, "INFO"), "INFO", if(match(_raw, "DEBUG"), "DEBUG", "UNKNOWN"))))
| search log_level="$log_level_filter$"
| stats count
```

#### Panel 2: Error Count
```spl
index=docker_logs service="$service_filter$" 
| eval log_level=if(match(_raw, "ERROR"), "ERROR", "")
| search log_level="ERROR"
| stats count
```
- **Format**: Add color ranges (green < 10 < yellow < red)

#### Panel 3: Active Services
```spl
index=docker_logs earliest=-5m
| stats dc(attrs.name) as active_services
```

#### Panel 4: Warning Count
```spl
index=docker_logs service="$service_filter$" 
| eval log_level=if(match(_raw, "WARN"), "WARN", "")
| search log_level="WARN"
| stats count
```

### Step 5: Add Log Volume Chart (Row 2)

Create **Area Chart**:
```spl
index=docker_logs service="$service_filter$"
| eval service=coalesce(attrs.name, source)
| timechart span=1m count by service limit=10
```

Configure:
- **Chart Type**: Area
- **Stack Mode**: Stacked
- **Legend**: Right side

### Step 6: Add Error Tracking (Row 3)

#### Panel 1: Error Rate Trend (Line Chart)
```spl
index=docker_logs service="$service_filter$"
| eval log_level=if(match(_raw, "ERROR"), "ERROR", if(match(_raw, "WARN"), "WARN", "OTHER"))
| search log_level IN (ERROR, WARN)
| timechart span=5m count by log_level
```

#### Panel 2: Log Level Distribution (Pie Chart)
```spl
index=docker_logs service="$service_filter$"
| eval log_level=case(
    match(_raw, "ERROR"), "ERROR",
    match(_raw, "WARN"), "WARN",
    match(_raw, "INFO"), "INFO",
    match(_raw, "DEBUG"), "DEBUG",
    1=1, "OTHER"
)
| stats count by log_level
```

### Step 7: Add Service Health Table (Row 4)

Create **Table**:
```spl
index=docker_logs earliest=-5m
| eval service=coalesce(attrs.name, source)
| stats count as total_events, 
        earliest(_time) as first_seen, 
        latest(_time) as last_seen by service
| eval events_per_min=round(total_events/5, 2)
| eval time_since_last=round((now()-last_seen)/60, 1)
| eval status=case(
    time_since_last < 2, "🟢 Active",
    time_since_last < 5, "🟡 Slow",
    1=1, "🔴 Inactive"
)
| sort - events_per_min
| table service, status, events_per_min, total_events, time_since_last
| rename service as "Service", 
         status as "Status",
         events_per_min as "Events/Min",
         total_events as "Total Events (5m)",
         time_since_last as "Minutes Since Last Log"
```

Add color formatting for Status column.

### Step 8: Add Recent Errors Table (Row 5)

Create **Table**:
```spl
index=docker_logs service="$service_filter$"
| eval log_level=if(match(_raw, "ERROR"), "ERROR", "")
| search log_level="ERROR"
| eval service=coalesce(attrs.name, source)
| eval message=_raw
| table _time, service, message
| head 50
| rename _time as "Timestamp", service as "Service", message as "Error Message"
```

### Step 9: Add Raw Logs (Row 8)

Create **Table** for live log viewer:
```spl
index=docker_logs service="$service_filter$"
| eval log_level=case(
    match(_raw, "ERROR"), "ERROR",
    match(_raw, "WARN"), "WARN",
    match(_raw, "INFO"), "INFO",
    match(_raw, "DEBUG"), "DEBUG",
    1=1, "UNKNOWN"
)
| search log_level="$log_level_filter$"
| eval service=coalesce(attrs.name, source)
| table _time, service, log_level, _raw
| head 100
| rename _time as "Timestamp", service as "Service", log_level as "Level", _raw as "Message"
```

### Step 10: Save and Test

1. Click **Save**
2. Test all time ranges (15m, 1h, 4h, 24h)
3. Test service filter dropdown
4. Verify data appears in all panels

## Dashboard Features

### What the Dashboard Shows:

1. **Key Metrics (Top Row)**
   - Total log events
   - Error count (with color thresholds)
   - Number of active services
   - Warning count

2. **Log Volume Over Time**
   - Stacked area chart showing activity by service
   - 1-minute resolution

3. **Error Tracking**
   - Line chart of error/warning trends
   - Pie chart of log level distribution

4. **Service Health**
   - Real-time table showing:
     - Which services are logging
     - Events per minute
     - Time since last log
     - Status indicators (🟢 Active, 🟡 Slow, 🔴 Inactive)

5. **Recent Errors**
   - Last 50 errors with timestamps
   - Filterable by service

6. **Pattern Detection**
   - Most common log messages
   - Normalized to detect patterns

7. **Raw Log Viewer**
   - Last 100 logs with filtering
   - Color-coded by severity

### Interactive Features:

- **Time Range Picker**: Change time window (default: last 60 minutes)
- **Service Filter**: Focus on specific service or view all
- **Log Level Filter**: Show only ERROR, WARN, INFO, or DEBUG
- **Auto-Refresh**: Set to refresh every 30 seconds or 1 minute

## Customization Tips

### Change Refresh Rate

1. Edit Dashboard
2. Click on any panel
3. **Edit Search**
4. Under **Time Range** set **Refresh** to `30s` or `1m`

### Add Alerts

Create alerts from dashboard searches:

1. Click on a panel's search
2. **Save As** → **Alert**
3. Configure:
   - **Trigger**: Number of Results > 10 (for errors)
   - **Time Range**: Last 5 minutes
   - **Cron Schedule**: `*/5 * * * *` (every 5 minutes)
   - **Actions**: Email, Webhook, etc.

### Color Themes

Customize colors for log levels:
- **ERROR**: `#D93F3C` (Red)
- **WARN**: `#F7BC38` (Orange)
- **INFO**: `#65A637` (Green)
- **DEBUG**: `#6DB7C6` (Blue)

### Add More Panels

Useful additional panels:
- **Container Restart Count** (if logging container lifecycle events)
- **API Response Times** (if structured logs include duration)
- **Database Query Metrics** (if services log query times)
- **Memory/CPU Usage** (if container stats are logged)

## Best Practices

1. **Set Appropriate Time Ranges**
   - Use last 1-4 hours for real-time monitoring
   - Use longer ranges for trend analysis

2. **Use Filters**
   - Focus on one service when troubleshooting
   - Filter by ERROR only when hunting issues

3. **Schedule Reports**
   - Daily summary of errors by service
   - Weekly trend analysis

4. **Create Drill-downs**
   - Click on error count → see error details
   - Click on service → see that service's logs

5. **Export and Share**
   - PDF reports for stakeholders
   - Share dashboard link with team

## Troubleshooting Dashboard

### No Data Showing

1. **Check index name**: Ensure `docker_logs` matches your index
2. **Check time range**: Expand to last 24 hours
3. **Verify logs are flowing**:
   ```spl
   index=docker_logs | head 10
   ```

### Slow Performance

1. **Reduce time range**: Use shorter windows (15m instead of 24h)
2. **Add summary indexing** for historical data
3. **Use report acceleration** for heavy searches

### Field Extraction Issues

If service names or log levels aren't extracted:

1. **Settings** → **Data** → **Fields**
2. Create field extractions for:
   - `service` from container name
   - `log_level` from log message pattern

## Next Steps

1. **Set Up Alerts** (see SPLUNK_SETUP.md for alert configuration)
2. **Create Custom Dashboards** for specific services
3. **Add Correlation Searches** to detect patterns across services
4. **Integrate with Incident Management** (PagerDuty, Slack, etc.)

## Dashboard Maintenance

- **Review weekly**: Check for new error patterns
- **Update filters**: Add new services as they're deployed
- **Tune thresholds**: Adjust color ranges based on normal operation
- **Archive old dashboards**: Keep historical versions for reference
