---

## title: Global sales

Orders from every market over the last 12 months.

```sql regions
select distinct region from orders.orders order by region
```

<Dropdown name=region data={regions} value=region title="Region" defaultValue="%">
  <DropdownOption value="%" valueLabel="All regions"/>
</Dropdown>

```sql period_orders
select * from orders.orders
where ordered_at >= '2025-11-01' and ordered_at < '2026-11-01'
  and region like '${inputs.region.value}'
```

```sql kpis
select
  sum(case when status = 'paid' then amount end) as revenue,
  count(case when status = 'paid' then 1 end) as orders,
  sum(case when status = 'paid' then amount end) / count(case when status = 'paid' then 1 end) as aov,
  count(case when status = 'refunded' then 1 end) / count(*) as refund_rate
from ${period_orders}
```

<BigValue data={kpis} value=revenue title="Revenue" fmt=usd1m/>
<BigValue data={kpis} value=orders title="Orders" fmt=num0/>
<BigValue data={kpis} value=aov title="Average order value" fmt=usd2/>
<BigValue data={kpis} value=refund_rate title="Refund rate" fmt=pct1/>

```sql revenue_by_region
select date_trunc('month', ordered_at::timestamp) as month, region, sum(amount) as revenue
from ${period_orders}
where status = 'paid'
group by all
order by month, region
```

<LineChart data={revenue_by_region} x=month y=revenue series=region title="Revenue by month, by region" yFmt=usd0k/>

```sql revenue_by_channel
select channel, sum(amount) as revenue
from ${period_orders}
where status = 'paid'
group by all
order by revenue desc
```

<BarChart data={revenue_by_channel} x=channel y=revenue swapXY=true title="Revenue by channel" yFmt=usd0k/>

```sql by_country
select
  country,
  sum(amount) as revenue,
  count(*) as orders,
  sum(amount) / count(*) as aov,
  count(distinct customer_id) as customers
from ${period_orders}
where status = 'paid'
group by all
order by revenue desc
limit 15
```

<DataTable data={by_country} title="Top countries by revenue" rows=15>
  <Column id=country/>
  <Column id=revenue fmt=usd0/>
  <Column id=orders fmt=num0/>
  <Column id=aov title="Average order value" fmt=usd2/>
  <Column id=customers fmt=num0/>
</DataTable>
