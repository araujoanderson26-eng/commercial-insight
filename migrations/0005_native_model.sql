-- Additive derived indexes for relational format v2. Raw input and all snapshots remain immutable.
CREATE TABLE ci_native_sales (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), row_no INTEGER NOT NULL,
 date TEXT, client TEXT, product TEXT, category TEXT, state TEXT, municipality TEXT, amount INTEGER,
 display TEXT NOT NULL, PRIMARY KEY(version_id,row_no)
);
CREATE INDEX ci_native_sales_date ON ci_native_sales(version_id,date,client,amount,row_no,state);
CREATE INDEX ci_native_sales_client ON ci_native_sales(version_id,client,date);
CREATE INDEX ci_native_sales_product ON ci_native_sales(version_id,product,date);
CREATE INDEX ci_native_sales_category ON ci_native_sales(version_id,category,date);
CREATE INDEX ci_native_sales_state ON ci_native_sales(version_id,state,date);
CREATE TABLE ci_native_returns (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), row_no INTEGER NOT NULL,
 date TEXT, client TEXT, product TEXT, category TEXT, state TEXT, amount INTEGER,
 display TEXT NOT NULL, PRIMARY KEY(version_id,row_no)
);
CREATE INDEX ci_native_returns_date ON ci_native_returns(version_id,date,client);
CREATE INDEX ci_native_returns_client ON ci_native_returns(version_id,client,date);
CREATE TABLE ci_native_customers (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), row_no INTEGER NOT NULL,
 client TEXT, representative TEXT, state TEXT, display TEXT NOT NULL, PRIMARY KEY(version_id,row_no)
);
CREATE INDEX ci_native_customers_client ON ci_native_customers(version_id,client,representative,state);
CREATE INDEX ci_native_customers_rep ON ci_native_customers(version_id,representative,client);
CREATE TABLE ci_native_regions (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), row_no INTEGER NOT NULL,
 state TEXT, regional TEXT, manager TEXT, display TEXT NOT NULL, PRIMARY KEY(version_id,row_no)
);
CREATE INDEX ci_native_regions_region ON ci_native_regions(version_id,regional,state);
CREATE INDEX ci_native_regions_manager ON ci_native_regions(version_id,manager,state);
CREATE TABLE ci_native_municipalities (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), row_no INTEGER NOT NULL,
 name TEXT, display TEXT NOT NULL, PRIMARY KEY(version_id,row_no)
);
CREATE INDEX ci_native_municipalities_name ON ci_native_municipalities(version_id,name);
CREATE TABLE ci_native_latitudes (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), row_no INTEGER NOT NULL,
 state TEXT, display TEXT NOT NULL, PRIMARY KEY(version_id,row_no)
);
CREATE INDEX ci_native_latitudes_state ON ci_native_latitudes(version_id,state);
CREATE TABLE ci_native_reparea (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), row_no INTEGER NOT NULL,
 state TEXT, display TEXT NOT NULL, PRIMARY KEY(version_id,row_no)
);
CREATE INDEX ci_native_reparea_state ON ci_native_reparea(version_id,state);
CREATE TABLE ci_native_calendar (
 version_id TEXT NOT NULL REFERENCES ci_imports(id), row_no INTEGER NOT NULL,
 date TEXT, display TEXT NOT NULL, PRIMARY KEY(version_id,row_no)
);
CREATE INDEX ci_native_calendar_date ON ci_native_calendar(version_id,date);
